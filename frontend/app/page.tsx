"use client"
import React, { useState, useEffect, useRef } from 'react'

type Citation = { id: number; title: string; pdf_id: string; page: number }
type Message = {
  role: 'user' | 'ai' | 'tool'
  text: string
  citations?: Citation[]
}

export default function Page() {
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{step: string; progress: number} | null>(null)
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([])
  const sseRef = useRef<EventSource | null>(null)
  const uploadSseRef = useRef<EventSource | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    
    setUploading(true)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const formData = new FormData()
      formData.append('file', file)
      
      try {
        // Start upload
        const res = await fetch('/api/proxy/upload_pdf', {
          method: 'POST',
          body: formData,
        })
        
        if (!res.ok) {
          const errText = await res.text()
          console.error('Upload error response:', errText)
          throw new Error(`Upload failed: ${res.status} ${res.statusText} - ${errText}`)
        }
        
        const data = await res.json()
        
        if (!data.upload_id) {
          throw new Error('No upload_id received from server')
        }
        
        // Listen to upload progress
        setUploadProgress({step: 'Starting upload...', progress: 0})
        const uploadId = data.upload_id
        
        if (uploadSseRef.current) uploadSseRef.current.close()
        
        // Add small delay to ensure backend queue is ready
        await new Promise(r => setTimeout(r, 100))
        
        const ev = new EventSource(`/api/proxy/upload_progress/${uploadId}`)
        uploadSseRef.current = ev
        
        ev.onopen = () => {
            console.log("SSE Connection opened")
        }
        
        ev.onerror = (err) => {
            console.error("SSE Connection Error:", err)
            // Don't close immediately on generic error, might be temporary
        }
        
        ev.addEventListener('progress', (e: any) => {
          const payload = JSON.parse(e.data)
          setUploadProgress({step: payload.text, progress: payload.progress})
        })
        
        ev.addEventListener('done', (e: any) => {
          const payload = JSON.parse(e.data)
          setUploadProgress({step: payload.message, progress: 100})
          setUploadedFiles(prev => [...prev, payload.filename])
          setTimeout(() => {
            setUploadProgress(null)
            ev.close()
            uploadSseRef.current = null
          }, 1500)
        })
        
        ev.addEventListener('error', (e: any) => {
          console.error('SSE Error event:', e)
          // SSE error events often don't have data payload
          const msg = e.data ? JSON.parse(e.data).message : 'Connection lost'
          setUploadProgress({step: `Error: ${msg}`, progress: 0})
          setTimeout(() => setUploadProgress(null), 3000)
          ev.close()
          uploadSseRef.current = null
        })
        
      } catch (err) {
        console.error('Upload failed:', err)
        setUploadProgress({step: 'Upload failed', progress: 0})
        setTimeout(() => setUploadProgress(null), 3000)
      }
    }
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const send = async () => {
    if (!prompt.trim()) return
    const res = await fetch('/api/proxy/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const data = await res.json()
    setJobId(data.job_id)
    setMessages((m) => [
      ...m,
      { role: 'user', text: prompt },
      { role: 'ai', text: '', citations: [] },
    ])
    setPrompt('')
  }

  useEffect(() => {
    if (!jobId) return
    if (sseRef.current) {
      sseRef.current.close()
      sseRef.current = null
    }
    const ev = new EventSource(`/api/proxy/stream/${jobId}`)
    sseRef.current = ev
    ev.addEventListener('text', (e: any) => {
      const payload = JSON.parse(e.data)
      setMessages((prev) => {
        const updated = [...prev]
        // Find the last AI message to update
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'ai') {
            updated[i] = { ...updated[i], text: updated[i].text + payload.chunk }
            return updated
          }
        }
        return prev
      })
    })
    ev.addEventListener('tool', (e: any) => {
      const payload = JSON.parse(e.data)
      setMessages((m) => [...m, { role: 'tool', text: payload.step }])
    })
    ev.addEventListener('citation', (e: any) => {
      const payload: Citation = JSON.parse(e.data)
      setMessages((prev) => {
        const updated = [...prev]
        // Find the last AI message to update
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'ai') {
            updated[i] = {
              ...updated[i],
              citations: [...(updated[i].citations || []), payload],
            }
            return updated
          }
        }
        return prev
      })
    })
    ev.addEventListener('done', () => {
      ev.close()
      sseRef.current = null
      setJobId(null)
    })
    return () => {
      ev.close()
      sseRef.current = null
    }
  }, [jobId])

  const statusLabel = jobId ? 'Streaming response…' : 'Ready'

  return (
    <main className="min-h-screen">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex flex-col gap-6 mb-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-sm uppercase tracking-[0.25em] text-slate-500">AI search chat</p>
              <h1 className="text-3xl font-semibold text-ink">Perplexity-style experience</h1>
            </div>
            <div className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                multiple
                onChange={handleFileUpload}
                className="hidden"
                id="pdf-upload"
              />
              <label
                htmlFor="pdf-upload"
                className={`flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 bg-white shadow-soft cursor-pointer hover:bg-slate-50 transition ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className="text-2xl">📄</span>
                <span className="text-sm font-medium">{uploading ? 'Uploading...' : 'Upload PDFs'}</span>
              </label>
              <div className="flex items-center gap-2 bg-white/80 border border-slate-200 shadow-soft px-3 py-2 rounded-full">
                <span className={`h-2 w-2 rounded-full ${jobId ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                <span className="text-sm font-medium text-slate-700">{statusLabel}</span>
              </div>
            </div>
          </div>
          {uploadedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {uploadedFiles.map((file, idx) => (
                <div key={idx} className="text-xs px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                  ✓ {file}
                </div>
              ))}
            </div>
          )}
          {uploadProgress && (
            <div className="glass-card rounded-xl p-4 border-2 border-cyan-200">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-3 h-3 rounded-full bg-cyan-500 pulse-dot" />
                <p className="text-sm font-semibold text-ink">{uploadProgress.step}</p>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                <div 
                  className="bg-gradient-to-r from-cyan-500 to-blue-600 h-full transition-all duration-300"
                  style={{width: `${uploadProgress.progress}%`}}
                />
              </div>
              <p className="text-xs text-slate-600 mt-1">{uploadProgress.progress}%</p>
            </div>
          )}
          <div className="glass-card rounded-2xl p-5">
            <div className="flex flex-col lg:flex-row gap-6">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex -space-x-2">
                    <span className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600" />
                    <span className="w-8 h-8 rounded-full bg-slate-900" />
                  </div>
                  <p className="text-sm text-slate-600">Streaming answers, inline citations, and tool traces.</p>
                </div>
                <div className="bg-white/70 border border-slate-200 rounded-xl p-4 h-[460px] overflow-auto shadow-soft">
                  {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 gap-3">
                      <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-slate-300 pulse-dot" />
                        <span className="w-2 h-2 rounded-full bg-slate-300 pulse-dot" style={{ animationDelay: '0.2s' }} />
                        <span className="w-2 h-2 rounded-full bg-slate-300 pulse-dot" style={{ animationDelay: '0.4s' }} />
                      </div>
                      <div>
                        <p className="font-semibold text-slate-700">Ask anything about your PDFs</p>
                        <p className="text-sm text-slate-500">We will stream reasoning steps and clickable citations.</p>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    {messages.map((m, idx) => {
                      if (m.role === 'tool') {
                        return (
                          <div key={idx} className="flex items-center gap-3 text-sm text-slate-600">
                            <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                            <span className="font-medium">{m.text}</span>
                          </div>
                        )
                      }
                      const isUser = m.role === 'user'
                      return (
                        <div key={idx} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                          <div className={`${isUser ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white' : 'bg-white border border-slate-200'} max-w-2xl rounded-2xl px-4 py-3 shadow-soft`}> 
                            {!isUser && <p className="text-xs font-semibold text-slate-500 mb-1">AI</p>}
                            <p className="leading-relaxed whitespace-pre-wrap text-[15px]">{m.text || '…'}</p>
                            {!isUser && m.citations && m.citations.length > 0 && (
                              <div className="flex flex-wrap gap-2 mt-3">
                                {m.citations.map((c, i) => (
                                  <button
                                    key={i}
                                    onClick={() => setSelectedCitation(c)}
                                    className="text-sm px-2.5 py-1 rounded-full bg-accentSoft text-cyan-800 border border-cyan-100 hover:shadow-sm transition"
                                  >
                                    [{i + 1}] {c.title}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-3">
                  <div className="flex gap-2">
                    <input
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Ask about a document, cite a section, or request a chart"
                      className="flex-1 px-4 py-3 rounded-xl border border-slate-200 bg-white/80 shadow-soft focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                    <button
                      onClick={send}
                      className="px-4 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-semibold shadow-soft hover:translate-y-[-1px] transition"
                    >
                      Send
                    </button>
                  </div>
                  <div className="flex gap-3 text-xs text-slate-500">
                    <span className="px-2 py-1 rounded-full bg-white/70 border border-slate-200">SSE streaming</span>
                    <span className="px-2 py-1 rounded-full bg-white/70 border border-slate-200">Tool traces</span>
                    <span className="px-2 py-1 rounded-full bg-white/70 border border-slate-200">Citations → PDF viewer</span>
                  </div>
                </div>
              </div>

              <div className="w-full lg:w-[320px] space-y-3">
                <div className="bg-panel text-white rounded-2xl p-4 shadow-soft border border-white/5">
                  <p className="text-sm uppercase tracking-[0.2em] text-cyan-200 mb-2">Live tools</p>
                  <div className="space-y-2 text-sm text-slate-100/90">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-cyan-400" /> Searching documents
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-300" /> Reading PDFs
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-300" /> Generating answer
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-slate-200/80">Tool steps appear inline while we stream text.</p>
                </div>

                <div className="bg-white/80 rounded-2xl border border-slate-200 shadow-soft p-4">
                  <p className="text-sm font-semibold text-ink mb-2">Citations</p>
                  <p className="text-sm text-slate-600">Click a citation badge to open the PDF preview. Add your PDFs via the backend upload endpoint.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedCitation && (
        <div className="fixed inset-y-10 right-8 w-[360px] bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-slate-500">Source</p>
              <p className="text-base font-semibold text-ink">{selectedCitation.title}</p>
              <p className="text-sm text-slate-600">Page {selectedCitation.page}</p>
            </div>
            <button onClick={() => setSelectedCitation(null)} className="text-slate-500 hover:text-slate-800">✕</button>
          </div>
          <div className="flex-1 rounded-xl bg-slate-50 border border-dashed border-slate-200 p-3 text-sm text-slate-600">
            PDF preview placeholder — integrate react-pdf to render and highlight this citation.
          </div>
          <a
            className="text-sm text-cyan-700 font-semibold"
            href={`/api/proxy/pdf/${selectedCitation.pdf_id}`}
            target="_blank"
            rel="noreferrer"
          >
            Open full PDF →
          </a>
        </div>
      )}
    </main>
  )
}
