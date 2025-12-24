import type { NextApiRequest, NextApiResponse } from 'next'

export const config = {
  api: {
    bodyParser: false, // Disable body parsing to handle streams (multipart, etc.)
    externalResolver: true,
  },
}

const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Reconstruct the URL path from the catch-all query
  const { path } = req.query
  const pathStr = Array.isArray(path) ? path.join('/') : path
  
  // Preserve query parameters
  const queryString = req.url?.split('?')[1] || ''
  const url = `${BACKEND}/${pathStr}${queryString ? '?' + queryString : ''}`

  try {
    // Prepare headers
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'host') continue
      // Keep content-length to ensure backend knows body size
      if (Array.isArray(value)) {
        value.forEach(v => headers.append(key, v))
      } else if (value) {
        headers.append(key, value)
      }
    }

    // Prepare fetch options
    const options: RequestInit = {
      method: req.method,
      headers: headers,
      // @ts-ignore: Node.js fetch supports Readable stream as body
      body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req,
      // @ts-ignore: duplex is required for streaming bodies in Node.js fetch
      duplex: 'half', 
    }

    const response = await fetch(url, options)

    // Forward status and headers
    res.status(response.status)
    response.headers.forEach((value, key) => {
      if (key === 'content-encoding' || key === 'content-length') return
      res.setHeader(key, value)
    })

    // Pipe the response body to the client
    if (response.body) {
      // @ts-ignore: Web ReadableStream to Node Writable Stream
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
    } else {
      res.end()
    }
  } catch (error) {
    console.error('Proxy error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy error' })
    }
  }
}
