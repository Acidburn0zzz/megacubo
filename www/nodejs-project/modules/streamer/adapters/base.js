
const path = require('path'), fs = require('fs'), http = require('http'), Events = require('events')
const WriteQueueFile = require(global.APPDIR + '/modules/write-queue/write-queue-file')

class StreamerAdapterBase extends Events {
	constructor(url, opts){
		super()
		this.url = url
		this.opts = {
			addr: '127.0.0.1',
			minBitrateCheckSize: 48 * 1024,
			maxBitrateCheckSize: 3 * (1024 * 1024),
			connectTimeout: global.config.get('connect-timeout') || 5,
			bitrateCheckingAmount: 3,
			maxBitrateCheckingFails: 8,
			debug: false,
			port: 0
		};
		this.downloadTimeout = {}
		let ms = this.opts.connectTimeout * 1000
		'lookup,connect,secureConnect,socket,response'.split(',').forEach(s => this.downloadTimeout[s] = ms)
		'send,request'.split(',').forEach(s => this.downloadTimeout[s] = ms * 2)
		this.defaults = this.opts
		if(opts){
			this.setOpts(opts)
		}
		this._dimensions = ''
		this.currentSpeed = -1
		this.connectable = false
		this.adapters = []
		this.bitrate = false
		this.bitrates = []
		this.errors = []
        this.type = 'base'
		this.getBitrateQueue = []
		this.bitrateChecking = false
		this.bitrateCheckFails = 0
		this.bitrateCheckBuffer = {}
		this.downloadLogging = {}
    }
    setOpts(opts){
        if(opts && typeof(opts) == 'object'){     
			Object.keys(opts).forEach((k) => {
				if(['debug'].indexOf(k) == -1 && typeof(opts[k]) == 'function'){
					this.on(k, opts[k])
				} else {
					this.opts[k] = opts[k]
					if(typeof(this.defaults[k]) == 'undefined'){
						this.defaults[k] = opts[k]
					}
				}
            })
        }
	}
    connectAdapter(adapter){  
		this.adapters.push(adapter) 
        adapter.on('dimensions', dimensions => {
			if(dimensions && this._dimensions != dimensions){
				this._dimensions = dimensions
				this.emit('dimensions', this._dimensions)
			}
        })
        adapter.on('codecData', codecData => {
			if(codecData && this.codecData != codecData){
				if(this.codecData){
					const badCodecs = ['', 'unknown']
					if(badCodecs.includes(codecData.video)){
						codecData.video = this.codecData.video
					}
					if(badCodecs.includes(codecData.audio)){
						codecData.audio = this.codecData.audio
					}
				}			
				this.codecData = codecData
				this.emit('codecData', this.codecData)
			}
        })
        adapter.on('speed', speed => {
			if(speed > 0 && this.currentSpeed != speed){
				this.currentSpeed = speed
			}
        })
        adapter.on('fail', this.onFail)
        this.on('commit', () => {
            adapter.emit('commit')
            if(!adapter.committed){
                adapter.committed = true
            }
        })
        this.on('uncommit', () => {
            if(adapter.committed){
            	adapter.emit('uncommit')
                adapter.committed = false
            }
		})
        adapter.on('bitrate', (bitrate, speed) => {
			if(speed && speed > 0){
				this.currentSpeed = speed
			}
			if(bitrate && this.bitrate != bitrate){
				this.bitrate = bitrate
				this.emit('bitrate', this.bitrate, this.currentSpeed)
			}
        })
		if(adapter.bitrate){
			this.bitrate = adapter.bitrate
			this.emit('bitrate', adapter.bitrate, this.currentSpeed)
		}
    }
    disconnectAdapter(adapter){
        adapter.removeListener('fail', this.onFail);
        ['dimensions', 'codecData', 'bitrate', 'speed', 'commit', 'uncommit'].forEach(n => adapter.removeAllListeners(n))
		let pos = this.adapters.indexOf(adapter)
		if(pos != -1){
			this.adapters.splice(pos, 1)
		}
    }
    onFail(err){
        if(!this.destroyed){
            console.log('[' + this.type + '] adapter fail', err)
            this.fail(err)
        }
    }
	getDomain(u){
		if(u && u.indexOf('//') != -1){
			let d = u.split('//')[1].split('/')[0]
			if(d == 'localhost' || d.indexOf('.') != -1){
				return d
			}
		}
		return ''
	}
	ext(url){
		return url.split('?')[0].split('#')[0].split('.').pop().toLowerCase()  
	}
	proto(url, len){
		var ret = '', res = url.match(new RegExp('^([A-Za-z0-9]{2,6}):'))
		if(res){
			ret = res[1]
		} else if(url.match(new RegExp('^//[^/]+\\.'))){
			ret = 'http'
		}
		if(ret && typeof(len) == 'number'){
			ret = ret.substr(0, len)
		}
		return ret
	}
	findTwoClosestValues(values){
		let distances = [], closest = [], results = []
		values.forEach((n, i) => {
			distances[i] = []
			values.forEach((m, j) => {
				if(i == j){
					distances[i][j] = Number.MAX_SAFE_INTEGER
				} else {
					distances[i][j] = Math.abs(m - n)
				}
			})
			let minimal = Math.min.apply(null, distances[i])
			closest[i] = distances[i].indexOf(minimal)
			distances[i] = minimal
		})
		let minimal = Math.min.apply(null, distances)
		let a = distances.indexOf(minimal)
		let b = closest[a]
		return [values[a], values[b]]		
	}
	saveBitrate(bitrate){
		this.bitrates.push(bitrate)
		if(this.bitrates.length >= 3){
			this.bitrate = this.findTwoClosestValues(this.bitrates).reduce((a, b) => a + b, 0) / 2
		} else {
			this.bitrate = this.bitrates.reduce((a, b) => a + b, 0) / this.bitrates.length
		}
	}
	pumpGetBitrateQueue(){
		this.bitrateChecking = false
		if(this.getBitrateQueue.length && !this.destroyed){
			this.getBitrate(this.getBitrateQueue.shift())
		}
	}
	getBitrate(file){
		if(this.bitrateChecking){
			if(!this.getBitrateQueue.includes(file)){
				this.getBitrateQueue.push(file)
			}
			return
		}
		this.bitrateChecking = true
		fs.stat(file, (err, stat) => {
			if(this.destroyed || this.bitrates.length >= this.opts.bitrateCheckingAmount || this.bitrateCheckFails >= this.opts.maxBitrateCheckingFails){
				this.bitrateChecking = false
				this.getBitrateQueue = []
				this.clearBitrateSampleFiles()
			} else if(err || stat.size < this.opts.minBitrateCheckSize){
				this.pumpGetBitrateQueue()
			} else {
				console.log('getBitrate', file, this.url, stat.size, this.opts.minBitrateCheckSize, traceback())
				global.ffmpeg.bitrate(file, (err, bitrate, codecData, dimensions, nfo) => {
					// fs.unlink(file, () => {})
					if(!this.destroyed){
						if(codecData && (codecData.video || codecData.audio) && codecData != this.codecData){
							this.codecData = codecData
							this.emit('codecData', codecData)	
						}
						if(dimensions && !this._dimensions){
							this._dimensions = dimensions
							this.emit('dimensions', this._dimensions)
						}
						if(err){
							this.bitrateCheckFails++
							this.opts.minBitrateCheckSize += this.opts.minBitrateCheckSize * 0.5
							this.opts.maxBitrateCheckSize += this.opts.maxBitrateCheckSize * 0.5
						} else {
							if(this.opts.debug){
								this.opts.debug('getBitrate', err, bitrate, codecData, dimensions, this.url)
							}
							if(bitrate){
								this.saveBitrate(bitrate)
								this.emit('bitrate', this.bitrate, this.currentSpeed)	
							}
							if(this.opts.debug){
								this.opts.debug('[' + this.type + '] analyzing: ' + file, 'sample len: '+ global.kbfmt(stat.size), 'bitrate: '+ global.kbsfmt(this.bitrate), this.bitrates, this.url)
							}
						}
						this.pumpGetBitrateQueue()
					}
				}, stat.size)
			}
		})
	}
	clearBitrateSampleFiles(){
		Object.keys(this.bitrateCheckBuffer).forEach(id => {
			let file = this.bitrateCheckBuffer[id].file
			this.bitrateCheckBuffer[id].destroy()
			fs.unlink(file, () => {})
		})
		this.bitrateCheckBuffer = {}
	}
	collectBitrateSample(chunk, offset, len, id = 'default'){
		this.downloadLog(len)
		if(this.committed && this.bitrates.length < this.opts.bitrateCheckingAmount && this.bitrateCheckFails < this.opts.maxBitrateCheckingFails){
			if(typeof(this.bitrateCheckBuffer[id]) == 'undefined'){
				let filename = id.split('?')[0].split('/').pop()
				if(!filename){
					filename = String(Math.random())
				}
				this.bitrateCheckBuffer[id] = new WriteQueueFile(global.streamer.opts.workDir +'/'+ global.sanitize(filename))
			}
			this.bitrateCheckBuffer[id].write(chunk, offset)
			if(this.bitrateCheckBuffer[id].written >= this.opts.maxBitrateCheckSize){
				this.finishBitrateSample(id)
				return false
			}
			return true
		}
	}
	finishBitrateSample(id = 'default'){
		if(typeof(this.bitrateCheckBuffer[id]) != 'undefined'){
			if(this.bitrates.length < this.opts.bitrateCheckingAmount){
				this.bitrateCheckBuffer[id].ready(() => {
					if(this.bitrateCheckBuffer[id].written >= this.opts.minBitrateCheckSize){
						this.getBitrate(this.bitrateCheckBuffer[id].file)
					}
				})
			}
		}
	}
	concatSlice(bufArr, limit){
		let len = 0
		bufArr.forEach((chunk, i) => {
			if(len >= limit){
				bufArr[i] = null
			} else if((len + chunk.length) > limit){
				let exceeds = (len + chunk.length) - limit
				bufArr[i] = bufArr[i].slice(0, chunk.length - exceeds)
			} else {
				len += chunk.length
			}
		})
		return Buffer.concat(bufArr.filter(c => c))
	}
	downloadLog(bytes){
		if(this.downloadLogCalcTimer){
			clearTimeout(this.downloadLogCalcTimer)
		}
		let nowMs = global.time(), now = parseInt(nowMs)
		if(typeof(this.downloadLogging[now]) == 'undefined'){
			this.downloadLogging[now] = bytes
		} else {
			this.downloadLogging[now] += bytes
		}
		let downloadLogCalcMinInterval = 1 // 1s
		if(!this.downloadLogCalcLastTime || this.downloadLogCalcLastTime < (nowMs - downloadLogCalcMinInterval)){
			this.downloadLogCalcLastTime = nowMs
			this.downloadLogCalc()
		} else {
			let delay = (this.downloadLogCalcLastTime + downloadLogCalcMinInterval) - nowMs
			this.downloadLogCalcTimer = setTimeout(() => this.downloadLogCalc(), delay * 1000)
		}
	}
	downloadLogCalc(){
		let now = parseInt(global.time())
		let ks = Object.keys(this.downloadLogging)
		if(ks.length){
			let windowSecs = 15, ftime = 0, since = now - windowSecs, downloaded = 0
			ks.reverse().forEach((time, i) => {
				let rtime = parseInt(time)
				if(typeof(rtime) == 'number' && rtime){
					if(rtime >= since || i < 10){ // keep at minimum 5 to prevent currentSpeed=N/A
						if(!ftime || ftime > rtime){
							ftime = rtime
						}
						downloaded += this.downloadLogging[time]
					} else {
						delete this.downloadLogging[time]
					}
				}					
			})
			let speed = parseInt(downloaded / (now - ftime)) * 8 // bytes to bits
			/*
			if(this.opts.debug){
				this.opts.debug('[' + this.type + '] download speed:', downloaded, now, ftime, speed, global.kbsfmt(speed) + ((this.bitrate) ? ', required: ' + global.kbsfmt(this.bitrate): ''))
			}
			*/
			if(speed != this.currentSpeed){
				this.currentSpeed = speed
				this.emit('speed', this.currentSpeed)
			}
		}
	}
	removeHeaders(headers, keys){
		keys.forEach(key => {
			if(['accept-encoding', 'content-encoding'].includes(key)){
				headers[key] = 'identity'
			} else {
				delete headers[key]
			}
		})
		return headers
	}
	len(data){
		if(!data){
			return 0
		} else if(Array.isArray(data)) {
			let len = 0
			data.forEach(d => {
				len += this.len(d)
			})
			return len
		} else if(typeof(data.byteLength) != 'undefined') {
			return data.byteLength
		} else {
			return data.length
		}
	}
	ip(){
		return this.opts.addr
	}
	setCallback(cb){
		this.once('ready', () => {
			if(typeof(cb) == 'function'){
				cb(true)
				cb = null
			}
		})
		this.once('fail', () => {
			if(typeof(cb) == 'function'){
				cb(false)
				cb = null
			}
		})
	}
	fail(err){
		if(!this.destroyed && !this.failed){
			this.failed = err || true
            console.log('[' + this.type + '] fail', err)
			this.errors.push(err)
			if(this.opts.debug){
				this.opts.debug('[' + this.type + '] error', this.errors)
			}
			this.emit('fail', err)
			process.nextTick(() => this.destroy())
		}
	}
	destroy(){
		if(this.opts.debug){
			this.opts.debug('[' + this.type + '] destroy', global.traceback())
		}
		if(!this.destroyed){
			this.destroyed = true
			this.emit('destroy')
			this.clearBitrateSampleFiles()
            this.adapters.forEach(a => a.destroy())
			this.downloadLogging = {}
			if(this.server){
				this.server.close()
			}
			this.removeAllListeners()
			this.on = this.emit = () => {}
		}
	}	
}

module.exports = StreamerAdapterBase

