'use strict';

const EventEmitter = require('events').EventEmitter;
const MediaRenderClient = require('upnp-mediarenderer-client');
const UpnpClient = require('node-ssdp').Client;

module.exports = class UpnpMediaRenderer extends EventEmitter {

	constructor() {
		super();
		this._deviceInitLock = new Set();
		this._foundDevices = {};
		this._devices = {};
		this.upnpClient = new UpnpClient();
		this.upnpClient.on('response', this._onUpnpClientResponse.bind(this));

		setInterval(this.scan.bind(this), 10 * 60 * 1000);
	}

	_initDevice(deviceData) {
		const deviceInfo = this.getFoundDevice(deviceData.id);
		if (deviceInfo) {
			this.setAvailable(deviceData);
			// Check if we have an old reference of the device (for instance when device IP changed) to remove all listeners
			const oldDevice = this.getDevice(deviceData);

			const device = this._devices[deviceData.id] = {
				id: deviceData.id,
				client: deviceInfo.client,
				deviceData,
				state: deviceInfo.status,
			};
			// Initialize device with initial state
			if (device.state.TransportState) {
				this.realtime(device.deviceData, 'speaker_playing', device.state.TransportState === 'PLAYING');
			}
			device.client.on('error', () => {
				this.setUnavailable(deviceData);
				if (device.speaker) {
					device.speaker.setInactive(new Error('disconnected'));
				}
				setTimeout(() => {
					device.client.removeAllListeners();
				}, 1000);
			});
			// Add status listener to listen for realtime state updates
			device.client.on('status', (status) => {
				Object.assign(device.state, status);
				this.realtime(device.deviceData, 'speaker_playing', device.state.TransportState === 'PLAYING');
				// console.log('got status volume realtime', status);
				this.realtime(device.deviceData, 'volume_set', Number(device.state.Volume) / 100);
			});
			// Manually poll volume since initial volume from status listener is incorrect
			device.client.once('status', () =>
				this.getVolume(
					device,
					(err, vol) => !err && this.realtime(device.deviceData, 'volume_set', vol)
				)
			);

			if (!(oldDevice instanceof Error)) {
				if (oldDevice.speaker) {
					device.speaker = oldDevice.speaker;
					delete oldDevice.speaker;
				}
				this._uninitDevice(oldDevice);
			}
			if (!device.speaker) {
				this._initSpeaker(device);
			}

			return device;
		} else {
			this.setUnavailable(deviceData, new Error('Device not found'));
		}
		this.once(`found:${deviceData.id}`, this._initDevice.bind(this, deviceData));
	}

	_uninitDevice(device) {
		if (device.client) {
			device.client.releaseEventingServer();
			device.client.removeListeners();
		}
		if (device.speaker) {
			this.unregisterSpeaker(device.deviceData);
		}
	}

	_initSpeaker(device) {
		this.registerSpeaker(device.deviceData, {
			codecs: this.codecs || ['homey:codec:mp3'],
		}, (err, speaker) => {
			if (err) return Homey.error(err);
			device.speaker = speaker;
			speaker.on('setTrack', (track, callback) => {
				console.log('set track', track);
				const curDevice = this.getDevice(device);
				if (curDevice) {
					this.setTrack(curDevice, track, callback);
				} else {
					callback(new Error('Could not find device'));
				}
			});
			speaker.on('setPosition', (position, callback) => {
				const curDevice = this.getDevice(device);
				if (curDevice) {
					this.setPosition(curDevice, position, callback);
				} else {
					callback(new Error('Could not find device'));
				}
			});
			speaker.on('setActive', (isActive, callback) => {
				// TODO add polling for playback state
				const curDevice = this.getDevice(device);
				if (curDevice) {
					this.setActiveSpeaker(curDevice, isActive, callback);
				} else {
					callback(new Error('Could not find device'));
				}
			});
		});
	}

	getFoundDevices() {
		return Object.keys(this._foundDevices)
			.filter(key => this._foundDevices[key].description)
			.map(key => this._foundDevices[key]);
	}

	getDevice(device) {
		if (!(device && device.id && this._devices[device.id])) {
			return new Error('Device not found or not initialized');
		}
		return this._devices[device.id];
	}

	getFoundDevice(id) {
		return this._foundDevices[id];
	}

	setActiveSpeaker(device, isActive, callback) {
		device.isActiveSpeaker = isActive;
		if (isActive) {
			device.updateStateInterval = setInterval(() => {
				device.client.getPosition((err, pos) => {
					device.speaker.updateState({ position: pos * 1000 });
					device.client.getTransportInfo((err, info) => {
						this.realtime(device.deviceData, 'speaker_playing', info.CurrentTransportState === 'PLAYING');
					});
				});
			}, 5000);
		} else if (device.updateStateInterval) {
			clearInterval(device.updateStateInterval);
			device.updateStateInterval = null;
		}
		callback(null, isActive);
	}

	setPosition(device, position, callback) {
		console.log('set position');
		device.client.seek(Math.round(position / 1000), (err) => {
			console.log('set position callback', err, position);
			if (err) return callback(err);
			callback(null, position);
		});
	}

	setTrack(device, data, callback) {
		const artwork = (data.track.artwork || {});
		const load = () => {
			this.realtime(device.deviceData, 'speaker_playing', false);

			device.client.load(
				data.track.stream_url,
				{
					autoplay: Boolean(data.opts.startPlaying),
					contentType: 'audio/mpeg',
					metadata: {
						title: data.track.title,
						creator: (data.track.artist || []).map(artist => artist.name).join(', '),
						images: [{
							url: artwork.large || artwork.medium || artwork.small,
						}],
						type: 'audio',
					},
				},
				(err, result) => {
					console.log('playtrack', err, result);
					if (err) {
						return callback(err);
					}
					device.speaker.updateState({ track: data.track, position: 0 }); // TODO data.opts.position });
					this.realtime(device.deviceData, 'speaker_playing', Boolean(data.opts.startPlaying));
					callback(null, data.track);
				}
			);
		};
		// Initial implementation of queue
		if (device.speaker.queuedCallback) {
			device.speaker.queuedCallback(new Error('setTrack debounced'));
			device.speaker.queuedCallback = null;
			clearTimeout(device.speaker.queuedTimeout);
		}
		if (data.opts.delay) {
			device.speaker.queuedCallback = callback;
			device.speaker.queuedTimeout = setTimeout(() => {
				device.speaker.queuedCallback = null;
				device.speaker.queuedTimeout = null;
				load();
			}, data.opts.delay);
		} else {
			load();
		}
	}

	getPlaying(device, callback) {
		if (!device.state || !device.state.TransportState) return callback(new Error('Device state is unknown'));
		callback(null, device.state.TransportState === 'PLAYING');
	}

	play(device, callback) {
		device.client.play((err, result) => {
			console.log('play', err, result);
			callback(err, result);
		});
	}

	pause(device, callback) {
		device.client.pause((err, result) => {
			console.log('pause', err, result);
			callback(err, result);
		});
	}

	previous(device, callback) {
		device.client.previous((err, result) => {
			callback(err, result);
		});
	}

	next(device, callback) {
		device.client.next((err, result) => {
			callback(err, result);
		});
	}

	getVolume(device, callback) {
		device.client.getVolume((err, result) => {
			callback(err, result ? result / 100 : result);
		});
	}

	setVolume(device, volume, callback) {
		device.client.setVolume(Math.round(volume * 100), (err) => {
			console.log('setted volume', Math.round(volume * 100), err);
			callback(err, volume);
		});
	}

	getMute(device, callback) {
		device.client.getMute((err, result) => {
			callback(err, Boolean(Number(result)));
		});
	}

	setMute(device, mute, callback) {
		device.client.setMute(mute ? '1' : '0', (err) => {
			callback(err, mute);
		});
	}

	get capabilities() {
		return {
			speaker_playing: {
				get: (deviceData, callback) => {
					this.log('capabilities.speaker_playing.get');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					this.getPlaying(device, callback);
				},
				set: (deviceData, value, callback) => {
					this.log('capabilities.speaker_playing.set');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					if (value) {
						this.play(device, callback);
					} else {
						this.pause(device, callback);
					}
				},
			},
			speaker_prev: {
				set: (deviceData, value, callback) => {
					this.log('capabilities.speaker_prev.set');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					this.previous(device, callback);
				},
			},
			speaker_next: {
				set: (deviceData, value, callback) => {
					this.log('capabilities.speaker_next.set');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					this.next(device, callback);
				},
			},
			volume_set: {
				get: (deviceData, callback) => {
					this.log('capabilities.volume_set.get');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					this.getVolume(device, (err, volume) => {
						console.log('get volume', err, volume);
						if (err) return callback(err);

						callback(null, volume);
					});
				},
				set: (deviceData, value, callback) => {
					this.log('capabilities.volume_set.set');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					this.setVolume(device, value, (err, volume) => {
						if (err) return callback(err);

						callback(null, volume);
					});
				},
			},
			volume_mute: {
				get: (deviceData, callback) => {
					this.log('capabilities.volume_mute.get');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					this.getMute(device, callback);
				},
				set: (deviceData, value, callback) => {
					this.log('capabilities.volume_mute.get');

					const device = this.getDevice(deviceData);
					if (device instanceof Error) return callback(device);

					this.setMute(device, value, callback);
				},
			},
		};
	}

	scan(timeout) {
		timeout = timeout || 10000;
		const scanTimeoutTime = Date.now() + timeout;
		const stopScanning = () => {
			this.upnpClient.stop();
			this._isScanning = false;
		};

		if (this._isScanning) {
			if (this._scanEnd < scanTimeoutTime) {
				clearTimeout(this._stopScanningTimeout);
				this._scanEnd = scanTimeoutTime;
				this._stopScanningTimeout = setTimeout(stopScanning, timeout);
			}
			return;
		}
		this._scanEnd = scanTimeoutTime;
		this._isScanning = true;
		this.upnpClient.search('urn:schemas-upnp-org:device:MediaRenderer:1');
		this._stopScanningTimeout = setTimeout(stopScanning, timeout);
	}

	_onUpnpClientResponse(headers, statusCode, info) {
		if (statusCode === 200 && headers.ST === 'urn:schemas-upnp-org:device:MediaRenderer:1' && !this._deviceInitLock.has(headers.USN) &&
			(!this._foundDevices[headers.USN] || this._foundDevices[headers.USN].headers.LOCATION !== headers.LOCATION)
		) {
			this._deviceInitLock.add(headers.USN);
			const client = new MediaRenderClient(headers.LOCATION);
			const deviceInfo = { headers, info, client, status: {} };

			client.on('error', (error) => {
				console.error('Client error', error);
				delete this._foundDevices[headers.USN];
			});

			Promise.all([
				new Promise((resolve, reject) => {
					const fetchInitialStatus = (status) => {
						Object.assign(deviceInfo.status, status);
						if (deviceInfo.status.hasOwnProperty('Volume') && deviceInfo.status.hasOwnProperty('TransportState')) {
							client.removeListener('status', fetchInitialStatus);
							resolve();
						}
					};
					client.on('status', fetchInitialStatus);
				}),
				new Promise((resolve, reject) => {
					client.getDeviceDescription((err, description) => {
						// Try to parse device description again after 60 seconds
						if (err || !description || !description.services['urn:upnp-org:serviceId:AVTransport']) {
							return reject(new Error('Not able to get correct device info'));
						}

						client.getMediaInfo(console.log.bind(console, 'mediaInfo'));
						deviceInfo.description = description;
						resolve();
					});
				}),
			]).then(() => {
				this._foundDevices[headers.USN] = deviceInfo;
				this.emit('found', deviceInfo);
				this.emit(`found:${headers.USN}`, deviceInfo);
				this._deviceInitLock.delete(headers.USN);
			}).catch((err) => {
				setTimeout(() => delete this._deviceInitLock.delete(headers.USN), 60000);
				this.error(err);
			});
		}
	}

	added(deviceData) {
		this.log('added', deviceData);
		this._initDevice(deviceData);
	}

	deleted(deviceData) {
		this.log('deleted', deviceData);
		this._uninitDevice(deviceData);
		delete this._devices[deviceData.id];
	}

	/*
	 Helper methods
	 */
	log() {
		console.log.bind(null, '[log]').apply(null, arguments);
	}

	error() {
		console.error.bind(null, '[err]').apply(null, arguments);
	}
};