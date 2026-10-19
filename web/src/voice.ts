// Voice input's browser side: records one clip from the microphone with MediaRecorder and
// reports its level for the prompt input's bar. The clip stays in memory; the prompt input
// posts it to /api/voice/transcribe (api.ts uploadClip) and then drops it.
export interface Recording { stop: () => Promise<Blob>; cancel: () => void }

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
const pickType = () => TYPES.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) ?? ''

export async function startRecording(onLevel: (level: number) => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  let ctx: AudioContext | undefined
  let frame = 0
  // Stops the mic and the analyser; the tracks must stop so the browser's mic light goes out.
  // Safe to call more than once, and on a half-built recording.
  const release = () => {
    cancelAnimationFrame(frame)
    ctx?.close().catch(() => {})
    ctx = undefined
    stream.getTracks().forEach((t) => t.stop())
  }
  try {
    const type = pickType()
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    const stopped = new Promise<Blob>((res) => { rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' })) })

    // The level comes from an analyser on the same stream; without one the bar just stays flat.
    try {
      ctx = new AudioContext()
      const an = ctx.createAnalyser()
      an.fftSize = 256
      ctx.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const tick = () => {
        an.getByteTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += ((v - 128) / 128) ** 2
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
        frame = requestAnimationFrame(tick)
      }
      tick()
    } catch {}

    rec.start()
    return {
      stop: () => {
        if (rec.state !== 'inactive') rec.stop()
        return stopped.finally(release)
      },
      cancel: () => {
        rec.onstop = null
        if (rec.state !== 'inactive') rec.stop()
        release()
      },
    }
  } catch (e) {
    // The mic was granted, so it is released here before the error goes to the caller.
    release()
    throw e
  }
}
