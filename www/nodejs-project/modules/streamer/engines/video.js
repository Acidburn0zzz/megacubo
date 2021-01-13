const fs = require('fs'), StreamerBaseIntent = require('./base.js'), StreamerProxy = require('../utils/proxy.js')

class StreamerVideoIntent extends StreamerBaseIntent {    
    constructor(data, opts, info){
        super(data, opts, info)
        this.type = 'mp4'
        this.mediaType = 'video'
        if(this.info.contentType && this.info.contentType.indexOf('o/') != -1){
            this.mimetype = this.info.contentType
        } else {
            this.mimetype = this.mimeTypes.video
        }
    }  
    _start(){   
        return new Promise((resolve, reject) => {
            if(this.opts['direct']){
                this.endpoint = this.data.url
                if(this.info && this.info.isLocalFile){
                    global.serve.serve(this.data.url, false, false).then(url => {
                        this.endpoint = url
                        global.serve.keepAwake(true)
                        this.on('uncommit', () => global.serve.keepAwake(false))
                        resolve()
                    }).catch(reject)
                } else {
                    resolve()
                }
            } else {
                this.adapter = new StreamerProxy(this.opts)
                this.adapter.opts.forceFirstBitrateDetection = true
                this.adapter.opts.minBitrateCheckSize = 3 * (1024 * 1024) // 4MB
                this.adapter.opts.maxBitrateCheckSize = this.adapter.opts.minBitrateCheckSize * 2
                this.adapter.opts.bitrateCheckingAmount = 1
                this.connectAdapter(this.adapter)
                this.adapter.start().then(() => {
                    this.endpoint = this.adapter.proxify(this.data.url)
                    resolve()
                }).catch(e => {
                    reject(e)
                })
            }
        })
    }
}

StreamerVideoIntent.mediaType = 'video'
StreamerVideoIntent.supports = (info) => {
    if(info.isLocalFile){
        return true
    }
    if(info.contentType){
        let c = info.contentType.toLowerCase()
        if(c.indexOf('mp2t') != -1){
            return false
        }
        if(c.indexOf('video') == 0){
            return true
        }
    }
    if(info.ext && ['mp4', 'mkv', 'm4v', 'webm', 'ogv', 'hevc', 'wmv', 'divx', 'avi', 'asf'].includes(info.ext)){
        return true
    }
    return false
}

module.exports = StreamerVideoIntent
