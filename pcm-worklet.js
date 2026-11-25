/**
 * pcm-worklet.js — Same-origin AudioWorkletProcessor for low-latency PCM microphone capture.
 * Hosted as a static file so the PWA CSP can strictly enforce `script-src 'self'; worker-src 'self';`
 * without permitting `blob:` script execution.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
