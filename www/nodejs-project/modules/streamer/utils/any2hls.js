const fs = require('fs'), http = require('http'), path = require('path'), closed = require(global.APPDIR +'/modules/on-closed'), decodeEntities = require('decode-entities'), Events = require('events')

class Any2HLS extends Events {
    constructor(source, opts){
        super()
        this.source = source 
        this.timeout = global.config.get('connect-timeout') * 6
        this.started = false
        this.type = 'any2hls'
        this.opts = {
            debug: false,
            workDir: global.streamer.opts.workDir,
            addr: '127.0.0.1',
            port: 0,
            videoCodec: 'copy',
            audioCodec: 'copy',
            inputFormat: null
        };
        this.setOpts(opts)
    }
    setOpts(opts){
        if(opts && typeof(opts) == 'object'){     
            Object.keys(opts).forEach((k) => {
                if(['debug'].indexOf(k) == -1 && typeof(opts[k]) == 'function'){
                    this.on(k, opts[k])
                } else {
                    this.opts[k] = opts[k]
                }
            })
        }
    }
    genUID(cb){          
        if(!this.uid){
            this.uid = parseInt(Math.random() * 1000000000)
        }
        fs.readdir(this.opts.workDir, (err, files) => {
            let next = files => {                
                while(files.includes(String(this.uid))) {
                    this.uid++
                }
                cb()
            }
            if(err){
                fs.mkdir(path.dirname(this.opts.workDir), {recursive: true}, () => next([]))
            } else {
                next(files)
            }
        })
    }
    waitFile(file, timeout, m3u8Verify) {
        return new Promise((resolve, reject) => {
            if(!file){
                return reject('no file specified')
            }
            let finished, watcher, timer = 0
            const s = global.time()
            const dir = path.dirname(file), basename = path.basename(file)
            const finish = oerr => {
                clearTimeout(timer)
                if(watcher){
                    watcher.close()
                    watcher = null
                }
                if(!finished){
                    finished = true
                    if(this.destroyed){
                        reject('destroyed')
                    } else {
                        const elapsed = global.time() - s
                        const timeouted = elapsed >= timeout
                        const t = timeouted ? ', timeout' : ' after '+ elapsed +'/'+ timeout +'s'
                        fs.access(dir, aerr => {
                            if (aerr) {
                                reject('dir not exists anymore'+ t)
                            } else {
                                fs.stat(file, (err, stat) => {
                                    if(stat && stat.size){
                                        resolve(stat)
                                    } else {
                                        if(timeouted){
                                            if(err){
                                                reject('file not found'+ t)
                                            } else {
                                                reject('file empty'+ t)
                                            }
                                        } else {
                                            reject(oerr)
                                        }
                                    }
                                })
                            }
                        })
                    }
                }
            }
            const verify = cb => {
                if(m3u8Verify === true){
                    fs.readFile(file, (err, content) => {
                        if(err || String(content).split('.ts').length < 4){
                            cb(false)
                        } else {
                            cb(true)
                        }
                    })
                } else {
                    cb(true)
                }
            }
            try {
                watcher = fs.watch(dir, (type, filename) => {
                    if(this.destroyed){
                        finish('destroyed')
                    } else if (type === 'rename' && filename === basename) {
                        fs.stat(file, (err, stat) => {
                            if(stat && stat.size){
                                verify(fine => {
                                    if(fine) finish()
                                })
                            }
                        })
                    }
                })
                watcher.on('error', finish)
            } catch(e) {
                finish(String(e))
            }
            fs.access(file, fs.constants.R_OK, err => {
                if(!err){
                    verify(fine => {
                        if(fine) finish()
                    })
                }
            })
            clearTimeout(timer)
            timer = setTimeout(() => {
                if(!finished){
                    if(this.destroyed){
                        finish('destroyed')
                    } else {
                        fs.access(file, fs.constants.R_OK, err => {
                            if(this.destroyed){
                                return finish('destroyed')
                            }
                            if (err) {
                                return finish('timeout')
                            }
                            verify(fine => {
                                if(fine){
                                    finish()
                                } else {
                                    finish('timeout')
                                }
                            })
                        })
                    }
                }
            }, timeout * 1000)
        })
    }
    proxify(file){
        if(typeof(file) == 'string'){
            if(!this.opts.port){
				console.error('proxify() before server is ready', file, global.traceback())
                return file // srv not ready
            }
            let host = 'http://'+ this.opts.addr +':'+ this.opts.port +'/'
            if(file.indexOf(host) != -1){
                return file
            }
			console.log('proxify before', file)
            let uid = '/'+ this.uid +'/', pos = file.indexOf(uid)
            if(pos != -1){
                file = '/'+ file.substr(pos + uid.length)
            }
            uid = '\\'+ this.uid +'\\', pos = file.indexOf(uid)
            if(pos != -1){
                file = '/'+ file.substr(pos + uid.length)
            }
            file = 'http://127.0.0.1:' + this.opts.port + file.replaceAll('\\', '/')
			console.log('proxify before', file)
        }
        return file
    }
    unproxify(url){
        if(typeof(url)=='string'){
            if(url.charAt(0) == '/'){
                url = url.slice(1)
            }
            url = url.replace(new RegExp('^.*:[0-9]+/+'), '')
            if(url.indexOf('&') != -1 && url.indexOf(';') != -1){
                url = decodeEntities(url)
            }
            url = url.split('?')[0].split('#')[0]
            url = path.resolve(this.opts.workDir + path.sep + this.uid + path.sep + url)
        }
        return url
    }
    prepareFile(file){ // not outdated
        return new Promise((resolve, reject) => {
            fs.stat(file, (err, stat) => {
                if(stat && stat.size){
                    resolve(stat)
                } else {
                    // is outdated file?
                    fs.readdir(this.opts.workDir + path.sep + this.uid, (err, files) => {
                        if(Array.isArray(files)){
                            let basename = path.basename(file)
                            let firstFile = files.sort().filter(f => f.indexOf('m3u8') == -1).shift()
                            if(basename < firstFile){
                                console.warn('Outdated file', basename, firstFile, files)
                                reject('outdated file')
                            } else {
                                console.warn('File not ready??', basename, firstFile, files)
                                this.waitFile(file, 10).then(resolve).catch(err => {
                                    console.error(err)
                                    reject(err)
                                })
                            }
                        } else {
                            reject('readdir failed')
                        }
                    })
                }
            })
        })
    }
    contentTypeFromExt(ext){
        let ct = ''
        switch(ext){
            case 'm3u8':
                ct =  'application/x-mpegURL'
                break
            case 'mp4':
            case 'm4v':
                ct =  'video/mp4'
                break
            case 'm4s':
                ct = 'video/iso.segment'
                break
            case 'ts':
            case 'mpegts':
            case 'mts':
                ct =  'video/MP2T'
                break
        }
        return ct
    }
    serve(){
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, response) => {
                const keepalive = this.committed && global.config.get('use-keepalive')
				const file = this.unproxify(req.url.split('#')[0]), fail = err => {
                    console.log('FFMPEG SERVE', err, file, this.destroyed)
                    const headers = { 
                        'access-control-allow-origin': '*',
                        'content-length': 0,
                        'connection': keepalive ? 'keep-alive' : 'close'
                    }
                    response.writeHead(404, headers)
                    response.end()
                }
                if(this.destroyed){
                    fail('destroyed')
                } else {
                    this.prepareFile(file).then(stat => {
                        let headers = {
                            'access-control-allow-origin': '*',
                            'content-length': stat.size,
                            'connection': keepalive ? 'keep-alive' : 'close'
                        }
                        let ctype = this.contentTypeFromExt(global.streamer.ext(file))
                        if(ctype){
                            headers['content-type'] =  ctype
                        }
                        let ended, stream = fs.createReadStream(file)
                        response.writeHead(200, headers)
                        if(this.listenerCount('data') && headers['content-type'] && headers['content-type'].substr(0, 6) == 'video/'){
                            let offset = 0
                            stream.on('data', chunk => {
                                let len = chunk.length
                                this.emit('data', req.url, chunk, len, offset)
                                offset += len
                            })
                        }
                        const end = () => {
                            if(!ended){
                                ended = true
                                response.end()
                                stream && stream.destroy()
                            }
                        }
                        closed(req, response, () => {
                            if(!ended){
                                end()
                            }
                        })
                        stream.pipe(response) 
                    }).catch(fail)
                }
            }).listen(0, this.opts.addr, (err) => {
                if (err) {
                    return reject('unable to listen on any port')
                }
                if(this.destroyed){
                    if(this.server){
                        this.server.close()
                        this.server = null
                    }
                    return reject('destroyed')
                }
                this.opts.port = this.server.address().port
                this.endpoint = this.proxify(this.decoder.file)
                console.log('FFMPEG SERVE', this.decoder.file)
                this.emit('ready')
                resolve()
            })
        })
    }
    start(){
        return new Promise((resolve, reject) => {
            const startTime = global.time()
            this.genUID(() => {
                if(this.destroyed){
                    return reject('destroyed')
                }
                // cores = Math.min(require('os').cpus().length, 2), 
                // fragTime=2 to start playing asap, it will generate 3 segments before create m3u8, so hls_init_time isn't enough
                // fragTime=1 may cause manifestParsingError "invalid target duration" on hls.js
                let fragTime = 2, lwt = global.config.get('live-window-time')
                if(typeof(lwt) != 'number'){
                    lwt = 120
                } else if(lwt < 30) { // too low will cause isBehindLiveWindowError
                    lwt = 30
                }
                let hlsListSize = Math.ceil(lwt / fragTime)
                this.decoder = global.ffmpeg.create(this.source).
                    
                    /* cast fix try
                    inputOptions('-re'). // https://stackoverflow.com/questions/48479141/understanding-ffmpeg-re-parameter
                    inputOptions('-ss', 1). // https://trac.ffmpeg.org/ticket/2220
                    inputOptions('-fflags +genpts').
                    //outputOptions('-vf', 'setpts=PTS').
                    outputOptions('-vsync', 1).
                    // outputOptions('-vsync', 0).
                    // outputOptions('-async', -1).
                    outputOptions('-async', 2).
                    outputOptions('-flags:a', '+global_header').
                    // outputOptions('-packetsize', 188).
                    outputOptions('-level', '4.1').
                    outputOptions('-x264opts', 'vbv-bufsize=50000:vbv-maxrate=50000:nal-hrd=vbr').
                    cast fix try end */

                    outputOptions('-fflags', '+igndts').
                    outputOptions('-hls_flags', 'delete_segments'). // ?? https://www.reddit.com/r/ffmpeg/comments/e9n7nb/ffmpeg_not_deleting_hls_segments/
                    outputOptions('-hls_time', fragTime).
                    outputOptions('-hls_list_size', hlsListSize).
                    outputOptions('-map', '0:a?').
                    outputOptions('-map', '0:v?').
                    outputOptions('-sn').
                    outputOptions('-preset', 'ultrafast').
                    format('hls')
                if(this.opts.inputFormat){
                    this.decoder.inputOption('-f', this.opts.inputFormat)
                }
                if(this.opts.audioCodec){
                    this.decoder.audioCodec(this.opts.audioCodec)
                }
                if(this.opts.videoCodec === null){
                    this.decoder.outputOptions('-vn')
                } else if(this.opts.videoCodec) {
                    if(this.opts.videoCodec == 'h264'){
                        this.opts.videoCodec = 'libx264'
                    }
                    if(this.opts.videoCodec){
                        this.decoder.videoCodec(this.opts.videoCodec)
                    }
                }
                if(this.opts.videoCodec == 'libx264') {
                    this.decoder.
                    /* HTML5 compat start */
                    outputOptions('-profile:v', 'baseline').
                    outputOptions('-shortest').
                    outputOptions('-pix_fmt', 'yuv420p').
                    outputOptions('-preset:v', 'ultrafast').
                    outputOptions('-movflags', '+faststart').
                    /* HTML5 compat end */

                    outputOptions('-crf', global.config.get('ffmpeg-crf')) // we are encoding for watching, so avoid to waste too much time and cpu with encoding, at cost of bigger disk space usage

                    let resolutionLimit = global.config.get('transcoding')
                    switch(resolutionLimit){
                        case '480p':
                            this.decoder.outputOptions('-vf', 'scale=\'min(852,iw)\':min\'(480,ih)\':force_original_aspect_ratio=decrease,pad=852:480:(ow-iw)/2:(oh-ih)/2')
                            break
                        case '720p':
                            this.decoder.outputOptions('-vf', 'scale=\'min(1280,iw)\':min\'(720,ih)\':force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2')
                            break
                        case '1080p':
                            this.decoder.outputOptions('-vf', 'scale=\'min(1920,iw)\':min\'(1080,ih)\':force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2')
                            break
                    }
                }
                if(this.opts.audioCodec == 'aac'){
                    this.decoder.outputOptions('-profile:a', 'aac_low').
                    outputOptions('-preset:a', 'ultrafast').
                    outputOptions('-b:a', '128k').
                    outputOptions('-ac', 2). // stereo
                    outputOptions('-ar', 48000).
                    outputOptions('-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0')   
                    // -bsf:a aac_adtstoasc // The aac_ adtstoasc switch may not be necessary with more recent versions of FFmpeg, which may insert the switch automatically. https://streaminglearningcenter.com/blogs/discover-six-ffmpeg-commands-you-cant-live-without.html
                }
                if (typeof(this.source) == 'string' && this.source.indexOf('http') == 0) { // skip other protocols
                    this.decoder.
                        inputOptions('-stream_loop', -1).
                        // inputOptions('-timeout', -1).
                        inputOptions('-reconnect', 1).
                        // inputOptions('-reconnect_at_eof', 1).
                        inputOptions('-reconnect_streamed', 1).
                        inputOptions('-reconnect_delay_max', 20)
                    this.decoder.
                        inputOptions('-icy', 0).
                        // inputOptions('-seekable', -1).
                        inputOptions('-multiple_requests', 1)
                    if(this.agent){
                        this.decoder.inputOptions('-user_agent', this.agent) //  -headers ""
                    }
                    if (this.source.indexOf('https') == 0) {
                        this.decoder.inputOptions('-tls_verify', 0)
                    }
                }
                this.decoder.
                once('end', data => {
                    if(!this.destroyed){
                        console.warn('file ended '+ data, traceback())
                        this.destroy()
                    }
                }).
                on('error', err => {
                    if(!this.destroyed && this.decoder){
                        err = err.message || err || 'ffmpeg fail'
                        console.error('an error happened after '+ (global.time() - startTime) +'s'+ (this.committed ? ' (committed)':'') +': ' + err)
                        let m = err.match(new RegExp('Server returned ([0-9]+)'))
                        if(m && m.length > 1){
                            err = parseInt(m[1])
                        }
                        this.emit('fail', err)
                        this.destroy()
                    }
                }).
                on('start', (commandLine) => {
                    if(this.destroyed){ // already destroyed
                        return
                    }
                    console.log('Spawned FFmpeg with command: ' + commandLine, 'file:', this.decoder.file, 'workDir:', this.opts.workDir, 'cwd:', process.cwd(), 'PATHs', global.paths, 'cordova:', !!global.cordova)
                })
                this.decoder.file = path.resolve(this.opts.workDir + path.sep + this.uid + path.sep + 'output.m3u8')
                fs.mkdir(path.dirname(this.decoder.file), {
                    recursive: true
                }, () => {
                    if(this.destroyed) return
                    fs.access(path.dirname(this.decoder.file), fs.constants.W_OK, (err) => {
                        if(this.destroyed) return
                        if(err){
                            console.error('FFMPEG cannot write', err)
                            reject('playback')
                        } else {
                            console.log('FFMPEG run: '+ this.source, this.decoder.file)
                            this.decoder.output(this.decoder.file).run()
                            this.emit('decoder', this.decoder)
                            this.waitFile(this.decoder.file, this.timeout, true).then(() => {
                                this.serve().then(resolve).catch(reject)
                            }).catch(e => {
                                console.error('waitFile failed', this.timeout, e)
                                if(e.indexOf('timeout') != -1){
                                    e = 'timeout'
                                }
                                reject(e)
                                this.destroy()
                            })
                        }
                    })
                })
            })
        })
    }
    destroy(){
        this.destroyed = true
        if(this.server){
            this.server.close()
            this.server = null
        }
        if(this.decoder){
            const file = this.decoder.file
            console.log('ffmpeg destroy: '+ file, global.traceback())
            this.decoder.kill()
            this.decoder = null
            if(file){
                global.rmdir(path.dirname(file), true)
            }
        }
    }
}

module.exports = Any2HLS

