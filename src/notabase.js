import Collection from './collection'


const NOTION_BASE_URL = "https://www.notion.so"

export default class Notabase {
    constructor(options = {}) {
        this.blockStore = {}
        this.collectionSchemaStore = {}
        const { proxy, token } = options
        // proxy > browser env + cloudflare worker
        // token > node env

        if (proxy) {
            const { url, authCode } = proxy
            // browser env
            this.url = url // cloudflare worker url
            // auth code for cloudflare worker (nobody knows but you ,same to the code that config in cf-worker)
            // without authCode you can only retrieve and cannot creat/update/delete
            this.authCode = authCode
            this.reqeust = {
                async post(path, data) {
                    let r = await fetch(`${url}${path}?body=${JSON.stringify(data)}`, {
                        method: 'GET',
                        headers: {
                            'content-type': 'application/json;charset=UTF-8',
                            'x-auth-code': authCode, // custom header
                        }
                    })
                    return await r.json()
                }
            }
        } else {
            // token node env 
            this.token = token
            let tkHeader = token ? { 'cookie': `token_v2=${token}` } : {}
            const fetch = require("node-fetch")

            // non-token browse ext env
            let credentials = !token ? { credentials: 'include' } : {}
            this.reqeust = {
                async post(path, data) {
                    let r = await fetch(`${NOTION_BASE_URL}${path}`,
                        {
                            method: 'POST',
                            headers: {
                                'accept-encoding': 'gzip, deflate',
                                'content-length': JSON.stringify(data).length,
                                'content-type': 'application/json;charset=UTF-8',
                                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
                                ...tkHeader
                            },
                            body: JSON.stringify(data),
                            ...credentials
                        })
                    return await r.json()
                }
            }
        }
    }

    getUrlBloackId(url) {
        let pUrl
        if (!process.browser) {
            const parse = require('url').parse
            pUrl = parse(url)
        } else {
            pUrl = new URL(url)
        }
        let pathList = pUrl.pathname.split('/')
        let blockID = pathList[pathList.length - 1]
        return blockID
    }


    async getBrowseableUrlByCollectionPageId(pageId) {
        let r = await this.getRecordValues([pageId], [])
        let viewId = r[0].value[pageId].view_ids[0]

        let browseableUrl = `${NOTION_BASE_URL}${this.getBlockHashId(pageId)}?v=${this.getBlockHashId(viewId)}`
        return browseableUrl
    }

    async getRecordValues(blockIds, collectionIds) {
        let requestsIds = [...blockIds.map(item => ({ "table": "block", "id": item })), ...collectionIds.map(item => ({ "table": "collection", "id": item }))]
        console.log(`>>>> getRecordValues:${requestsIds}`)
        let data = await this.reqeust.post(`/api/v3/getRecordValues`,
            {
                requests: requestsIds
            })
        return data.results
    }

    getBlockHashId(blockId) {
        return blockId.split('-').join('')
    }
    getFullBlockId(blockId) {
        if (blockId.match("^[a-zA-Z0-9]+$")) {
            return blockId.substr(0, 8) + "-"
                + blockId.substr(8, 4) + "-"
                + blockId.substr(12, 4) + "-"
                + blockId.substr(16, 4) + "-"
                + blockId.substr(20, 32)
        } else {
            return blockId
        }
    }

    async getPageCollectionInfo(pageId) {
        console.log(`>>>> getPageChunk:${pageId}`)
        let data = await this.reqeust.post(`/api/v3/loadPageChunk`,
            { "pageId": this.getFullBlockId(pageId), "limit": 50, "cursor": { "stack": [] }, "chunkNumber": 0, "verticalColumns": false }
        )
        let collectionId = Object.entries(data.recordMap.collection)[0][0]
        let collectionViewId = Object.entries(data.recordMap.collection_view)[0][0]
        return [collectionId, collectionViewId]
    }

    getBrowseableUrl(blockID) {
        return `${NOTION_BASE_URL}/${blockID.split('-').join('')}`
    }

    parseImageUrl(url, width) {
        let rUrl
        if (url.startsWith("https://s3")) {
            let [parsedOriginUrl] = url.split("?")
            rUrl = `${NOTION_BASE_URL}/image/${encodeURIComponent(parsedOriginUrl).replace("s3.us-west", "s3-us-west")}`
        } else if (url.startsWith("/image")) {
            rUrl = `${NOTION_BASE_URL}${url}`
        } else {
            rUrl = url
        }

        if (width) {
            return `${rUrl}?width=${width}`
        } else {
            return rUrl
        }
    }


    async fetchCollectionData(collectionId, collectionViewId) {

        let data = await this.reqeust.post(`/api/v3/queryCollection`, {
            collectionId,
            collectionViewId,
            loader: { type: "table" }
        })
        console.log(`>>>> queryCollection:${collectionId}`)
        // prefetch relation  data 
        let schema = data.recordMap.collection[collectionId].value.schema
        this.collectionSchemaStore[collectionId] = schema
        return new Collection(collectionId, collectionViewId, data, this)
    }
    async _fetch(urlOrPageId) {
        let collectionId, collectionViewId
        if (urlOrPageId.match("^[a-zA-Z0-9-]+$")) {
            // pageId with '-' split
            [collectionId, collectionViewId] = await this.getPageCollectionInfo(this.getBlockHashId(urlOrPageId))
        } else if (urlOrPageId.startsWith("http")) {
            // url 
            let [base, params] = urlOrPageId.split('?')

            if (!process.browser) {
                const { URLSearchParams } = require('url')
            }
            let p = new URLSearchParams(params)

            let baseUrlList = base.split('/'); // 这里需要添加分号，否则编译出错。 参见 https://www.zhihu.com/question/20298345/answer/49551142
            [collectionId, collectionViewId] = await this.getPageCollectionInfo(baseUrlList[baseUrlList.length - 1])
        }
        let r = await this.fetchCollectionData(collectionId, collectionViewId)
        return r
    }

    async fetch(dbMap) {
        let db = {}
        let requests = Object.entries(dbMap).map(item => {
            let [tableName, url] = item
            db[tableName] = {}
            return this._fetch(url)
        })
        let res = await Promise.all(requests)
        Object.entries(dbMap).map((item, index) => {
            let [tableName, url] = item
            db[tableName] = res[index]
        })
        return db
    }
}