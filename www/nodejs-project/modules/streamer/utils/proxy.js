
const http = require('http'), path = require('path'), parseRange = require('range-parser'), closed = require(global.APPDIR +'/modules/on-closed')
const StreamerProxyBase = require('./proxy-base'), decodeEntities = require('decode-entities'), m3u8Parser = require('m3u8-parser')

class StreamerProxy extends StreamerProxyBase {
	constructor(opts){
		super(opts)
		this.opts.port = 0
		this.type = 'proxy'
		this.networkOnly = false
		this.connections = {}
		this.internalRequestAbortedEvent = 'request-aborted'
		this.opts.followRedirect = true
		this.opts.forceExtraHeaders = null
		if(this.opts.debug){
			this.opts.debug('OPTS', this.opts)
		}
		this.on('destroy', () => {
			console.warn('proxy.destroy()', Object.keys(this.connections))
			Object.keys(this.connections).forEach(this.destroyConn.bind(this))
			this.connections = {}
			if(this.server){
				this.server.close()
			}
		})
	}
	destroyConn(uid, data=false, force=true){
		if(this.connections[uid]){
			if(this.connections[uid].response){
				if(data && typeof(data) != 'number' && global.isWritable(this.connections[uid].response)){
					if(!this.connections[uid].response.headersSent){
						this.connections[uid].response.setHeader('access-control-allow-origin', '*')
					}
					this.connections[uid].response.end(data)
				} else {
					this.connections[uid].response.end()
				}
			}
			if(this.connections[uid].download){
				this.connections[uid].download.destroy()
			}
			delete this.connections[uid]
		}
	}
	destroyAllConns(){
		Object.keys(this.connections).forEach(uid => {
			this.destroyConn(uid, false, true)
		})
	}
    proxify(url){
        if(typeof(url) == 'string' && url.indexOf('//') != -1){
            if(!this.opts.port){
				console.error('proxify() before server is ready', url, global.traceback())
                return url // srv not ready
            }
			url = this.unproxify(url)
			if(url.substr(0, 7) == 'http://') {
				url = 'http://'+ this.opts.addr +':'+this.opts.port+'/'+ url.substr(7)
			} else if(url.substr(0, 8) == 'https://') {
				url = 'http://'+ this.opts.addr +':'+ this.opts.port +'/s/'+ url.substr(8)
			}
        }
        return url
    }
    unproxify(url){
        if(typeof(url) == 'string'){
            if(url.substr(0, 3) == '/s/'){
                url = 'https://' + url.substr(3)
            } else if(url.charAt(0) == '/' && url.charAt(1) != '/'){
                url = 'http://' + url.substr(1)
            } else if(this.opts.addr && url.indexOf('//') != -1){
				if(!this.addrp){
					this.addrp = this.opts.addr.split('.').slice(0, 3).join('.')
				}
                if(url.indexOf(this.addrp) != -1){
					url = url.replace(new RegExp('^(http://|//)'+ this.addrp.replaceAll('.', '\\.') +'\\.[0-9]{0,3}:([0-9]+)/', 'g'), '$1')
					url = url.replace('://s/', 's://')
                }  
            }                      
            if(url.indexOf('&') != -1 && url.indexOf(';') != -1){
                url = decodeEntities(url)
            }
        }
        return url
	}
	proxifyM3U8(body, url){
		body = body.replace(new RegExp('^ +', 'gm'), '')
		body = body.replace(new RegExp(' +$', 'gm'), '')
		let parser = new m3u8Parser.Parser(), replaces = {}, u
		parser.push(body)
		parser.end()
		// console.log('M3U8 PARSED', url, parser)
		if(parser.manifest){
			let qs = url.indexOf('?') ? url.split('?')[1] : ''
			if(parser.manifest.segments && parser.manifest.segments.length){
				// this.keepJournal(url, parser.manifest.segments) // TODO
				parser.manifest.segments.map(segment => {
					segment.uri = segment.uri.trim()
					let dn = this.getURLRoot(segment.uri)
					if(typeof(replaces[dn]) == 'undefined'){
						let df = segment.uri.length - dn.length
						if(this.opts.debug){
							this.opts.debug('dn', dn, df, segment.uri)
						}
						u = this.absolutize(segment.uri, url)
						let n = this.proxify(u)
						replaces[dn] = n.substr(0, n.length - df)
						if(this.opts.debug){
							this.opts.debug('replace', dn, replaces[dn], df, n)
						}
						body = this.applyM3U8Replace(body, dn, replaces[dn])
						if(this.opts.debug){
							this.opts.debug('ok')
						}
					}
				})
			}
			if(parser.manifest.playlists && parser.manifest.playlists.length){
				if(typeof(this.playlists[url]) == 'undefined'){
					this.playlists[url] = {}
				}
				parser.manifest.playlists.forEach(playlist => {
					let dn = this.dirname(url)
					if(typeof(replaces[dn]) == 'undefined'){
						if(this.opts.debug){
							this.opts.debug('dn', dn)
						}
						u = this.absolutize(playlist.uri, url)
						if(!Object.keys(this.playlists[url]).includes(u)){
							this.playlists[url][u] = true // true here means "online"
						}
						replaces[dn] = this.dirname(this.proxify(u))
						if(this.opts.debug){
							this.opts.debug('replace', dn, replaces[dn])
						}
						body = this.applyM3U8Replace(body, dn, replaces[dn])
						if(this.opts.debug){
							this.opts.debug('ok')
						}
					}
				})
			}
			//console.warn('PRXBODY', body, parser.manifest, replaces)
		}
		return body
	}
	applyM3U8Replace(body, from, to){
		let lines = body.split("\n")
		lines.forEach((line, i) => {
			if(line.length < 3 || line.charAt(0) == '#'){
				return
			}
			if(line.indexOf('/') == -1 || line.substr(0, 2) == './' || line.substr(0, 3) == '../'){
				// keep it relative, no problem in these cases
				/*
				if(from == ''){
					lines[i] = to + line
				}
				*/
			} else {
				if(line.substr(0, from.length) == from){
					lines[i] = to + line.substr(from.length)
				}
			}
		})
		return lines.join("\n")
	}
    contentRange(type, size, range) {
		const irange = range || {start: 0, end: size - 1}
    	return type + ' ' + irange.start + '-' + irange.end + '/' + (size || '*')
    }
	start(){
		return new Promise((resolve, reject) => {
			this.server = http.createServer(this.handleRequest.bind(this)).listen(0, this.opts.addr, (err) => {
				if (err) {
					if(this.opts.debug){
						this.opts.debug('unable to listen on port', err)
					}
					this.fail()
					reject(err)
					return
				}
				this.connectable = true
				this.opts.port = this.server.address().port
				resolve(true)
			})
		})
	}
	setNetworkOnly(enable){
		this.networkOnly = enable
		this.destroyAllConns()
	}
	handleRequest(req, response){
		if(this.destroyed || req.url.indexOf('favicon.ico') != -1){
			response.writeHead(404, {
				'Access-Control-Allow-Origin': '*'
			})
			return response.end()
		}
		if(this.networkOnly){
			if(this.type != 'network-proxy'){
				if(!req.headers['x-from-network-proxy'] && !req.rawHeaders.includes('x-from-network-proxy')){
					console.warn('networkOnly block', this.type, req.rawHeaders)
					response.writeHead(504, {
						'Access-Control-Allow-Origin': '*'
					})
					return response.end()
				}
			}
		}
		if(this.debug){
			this.debug('req starting...', req, req.url)
		}
		const uid = this.uid()
		const keepalive = this.committed && global.config.get('use-keepalive')
		let ended, url = this.unproxify(req.url)
		let reqHeaders = req.headers
		reqHeaders['accept-encoding'] =  'identity' // not needed and problematic
		reqHeaders = this.removeHeaders(reqHeaders, ['cookie', 'referer', 'origin'])
		if(this.type == 'network-proxy'){
			reqHeaders['x-from-network-proxy'] = '1'
		} else {
			if(reqHeaders['x-from-network-proxy']){
				delete reqHeaders['x-from-network-proxy']
			}
		}
		if(this.debug){
			this.debug('serving', url, req, path.basename(url), url, reqHeaders, uid)
		}
		if(this.type == 'network-proxy'){
			console.log('network serving', url, reqHeaders)
		}
		const download = new global.Download({
			url,
			retries: 10,
			headers: reqHeaders,
			authURL: this.opts.authURL || false, 
			keepalive,
			followRedirect: this.opts.followRedirect
		})
		this.connections[uid] = {response, download}
		const end = data => {
			if(!ended){
				ended = true
				this.destroyConn(uid, data, false)
			}
			if(this.opts.debug){
				this.opts.debug('ended', uid, traceback())
			}
		}
		closed(req, response, () => {
			if(!ended){ // req disconnected
				if(this.opts.debug){
					this.opts.debug('response closed', ended, response.ended)
				}
				response.emit(this.internalRequestAbortedEvent)
				response.end()
				if(this.connections[uid] && this.connections[uid].response){
					this.connections[uid].response.emit(this.internalRequestAbortedEvent)
				}
				end()
			}
		})
		download.on('error', err => {
			if(this.type == 'network-proxy'){
				console.log('serving', url, err)
			}
			if(this.committed){
				global.osd.show(global.streamer.humanizeFailureMessage(err.response ? err.response.statusCode : 'timeout'), 'fas fa-times-circle', 'debug-conn-err', 'normal')
				if(this.debug){
					this.debug('download err', err)
				}
			}
		})
		download.once('response', (statusCode, headers) => {
			headers = this.removeHeaders(headers, [
				'transfer-encoding', 
				'content-encoding', 
				'keep-alive',
				'strict-transport-security',
				'content-security-policy',
				'x-xss-protection',
				'cross-origin-resource-policy'
			])
			headers['access-control-allow-origin'] = '*'
			if(this.opts.forceExtraHeaders){
				headers = Object.assign(headers, this.opts.forceExtraHeaders)
			}
			if(this.debug){
				this.debug('download response', statusCode, headers, uid)
			}
			if(keepalive){
				headers['connection'] = 'keep-alive' // force keep-alive to reduce cpu usage, even on local connections, is it meaningful? I don't remember why I commented below that it would be broken :/
			} else {
				headers['connection'] = 'close' // always force connection close on local servers, keepalive will be broken
			}
			if(statusCode >= 200 && statusCode < 300){ // is data response
				if(!headers['content-disposition'] || headers['content-disposition'].indexOf('attachment') == -1 || headers['content-disposition'].indexOf('filename=') == -1){
					// setting filename to allow future file download feature
					// will use sanitize to prevent net::ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION on bad filename
					headers['content-disposition'] = 'attachment; filename="' + global.filenameFromURL(url) + '"'
				}
				let len = parseInt(headers['content-length'])
				if(len && typeof(headers['content-range']) == 'undefined'){
					headers['content-range'] = 'bytes 0-'+ (len - 1) +'/'+ len // improve upnp compat
				}
				if(req.method == 'HEAD'){
					if(this.debug){
						this.debug('download sent response headers', statusCode, headers)
					}
					response.writeHead(statusCode, headers)
					end()
				} else {
					const mediaType = this.getMediaType(headers, url)
					switch(mediaType){
						case 'meta':
							this.handleMetaResponse(download, statusCode, headers, response, end, url)
							break
						case 'video':
							this.handleVideoResponse(download, statusCode, headers, response, end, url, uid)
							break
						default:
							this.handleGenericResponse(download, statusCode, headers, response, end)
					}
				}
			} else {
				if(this.committed && (!statusCode || statusCode < 200 || statusCode >= 400)){ // skip redirects
					global.osd.show(global.streamer.humanizeFailureMessage(statusCode || 'timeout'), 'fas fa-times-circle', 'debug-conn-err', 'normal')
				}
				let location
				headers['content-length'] = 0
				if(typeof(headers.location) != 'undefined') {
					location = this.proxify(this.absolutize(headers.location, url))
				}
				if(location){
					headers.location = location
					statusCode = (statusCode >= 300 && statusCode < 400) ? statusCode : 307
					response.writeHead(statusCode, headers)		
					if(this.debug){
						this.debug('download sent response headers', statusCode, headers)
					}			
				} else {
					// we'll avoid to passthrough 403 errors to the client as some streamsmay return it esporadically
					statusCode = statusCode && ![401, 403].includes(statusCode) ? statusCode : 504
					response.writeHead(statusCode, headers)	
					if(this.debug){
						this.debug('download sent response headers', statusCode, headers)
					}			

				}
				end()
			}
		})
		download.start()
	}
	handleMetaResponse(download, statusCode, headers, response, end, url){
		if(!headers['content-type']){
			headers['content-type'] = 'application/x-mpegURL'
		}	
		headers = this.removeHeaders(headers, ['content-length']) // we'll change the content
		headers = this.addCachingHeaders(headers, 6) // set a min cache to this m3u8 to prevent his overfetching
		download.once('end', data => {
			if(data.length > 12){
				data = this.proxifyM3U8(String(data), download.currentURL)
				headers['content-length'] = data.length
				if(!response.headersSent){
					response.writeHead(statusCode, headers)
					if(this.debug){
						this.debug('download sent response headers', statusCode, headers)
					}
				}
				if(this.opts.debug){
					this.opts.debug('M3U8 ' + data, url)
				}
			} else {
				console.error('Invalid response from server', url, data)
				if(!response.headersSent){
					response.writeHead(504, headers)
					if(this.debug){
						this.debug('download sent response headers', 504, headers)
					}
				}
			}
			end(data)
		})
	}
	handleVideoResponse(download, statusCode, headers, response, end, url, uid){
		if(this.opts.forceVideoContentType){
			headers['content-type'] = this.opts.forceVideoContentType
		} else if(!headers['content-type'] || !headers['content-type'].match(new RegExp('^(audio|video)'))){ // fix bad mimetypes
			switch(this.ext(url)){
				case 'ts':
				case 'mts':
				case 'm2ts':
					headers['content-type'] = 'video/MP2T'
					break
				default:
					headers['content-type'] = 'video/mp4'
			}
		}
		if(!response.headersSent){
			if(this.debug){
				this.debug('download sent response headers', statusCode, headers)
			}
			response.writeHead(statusCode, headers)
		}
		let initialOffset = download.requestingRange ? download.requestingRange.start : 0, offset = initialOffset
		let sampleCollected, doBitrateCheck = this.committed && this.type != 'network-proxy' && this.bitrates.length < this.opts.bitrateCheckingAmount
		let onend = () => {
			//console.warn('download ended')
			if(doBitrateCheck){
				console.log('finishBitrateSampleProxy', url, sampleCollected, initialOffset, offset)
				this.finishBitrateSample(url)
			}
			end()
		}
		// console.warn('handleVideoResponse', doBitrateCheck, this.opts.forceFirstBitrateDetection, offset, download, statusCode, headers)
		download.on('data', chunk => {
			response.write(chunk)
			let len = this.len(chunk)
			if(this.listenerCount('data')){
				this.emit('data', url, chunk, len, offset)
			}
			this.downloadLog(len)
			if(doBitrateCheck && !sampleCollected){
				//console.warn('forceFirstBitrateDetection data', this.bitrateCheckBuffer[uid], offset, chunk)
				if(!this.collectBitrateSample(chunk, offset, len, url)){                       
					sampleCollected = true
					console.log('collectBitrateSampleProxy', url, sampleCollected, initialOffset, offset)
				}
			}
			offset += len
		})
		download.once('end', onend)
		if(download.ended){
			onend()
		}
	}	
	handleGenericResponse(download, statusCode, headers, response, end){
		if(!response.headersSent){
			response.writeHead(statusCode, headers)
			if(this.debug){
				this.debug('download sent response headers', statusCode, headers)
			}
		}
		download.on('data', chunk => response.write(chunk))
		download.once('end', () => end())
	}	
}

module.exports = StreamerProxy
