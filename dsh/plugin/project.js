/**
 * Projection from the harness message vocabulary (dsh RequestMessage[]) into the
 * core's OpenAI wire vocabulary. Input is deep-frozen by the loop: every result
 * is a freshly built object, and no field is ever written back.
 *
 * Image handling: the adapter pre-resolves image blocks through the harness
 * attachment service and hands this layer a synchronous resolver; a forwarded
 * image becomes an OpenAI `image_url` part on the roles the wire tolerates
 * (user, tool — the same role set dsh's own pi-ai route admits). Anything the
 * resolver cannot serve (offloaded occurrence, unreadable bytes, a model that
 * does not declare image input) projects to stable placeholder text: silently
 * dropping attachments would make the model lie about what it sees. File
 * attachments stay placeholder text for now (the wire has no file part).
 */

const IMAGE_PLACEHOLDER = '[image attached to this message; not forwarded by the bridge]'
const FILE_PLACEHOLDER = '[file attached to this message; not forwarded by the bridge]'

function blocksOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

/** Resolver answer for one image block, falling back to the generic placeholder. */
function imageText(block, served) {
  return typeof served?.text === 'string' ? served.text : IMAGE_PLACEHOLDER
}

function blocksToText(blocks, resolveImage) {
  const parts = []
  for (const block of blocksOf(blocks)) {
    if (block.type === 'text') parts.push(block.text ?? '')
    else if (block.type === 'image') parts.push(imageText(block, resolveImage?.(block)))
    else if (block.type === 'file') parts.push(FILE_PLACEHOLDER)
    // reasoning/tool-call/tool-addition/tool-removal are handled per-role, not as text
  }
  return parts.join('')
}

/**
 * The `Error: ` marker a tool-failure message carries so the model reads the
 * turn as a failure. Works on both projections of blocksToContent: the plain
 * string, and the parts array an image-bearing result produces (where the
 * naive string check used to drop the marker exactly when the failure showed
 * a screenshot).
 */
function withErrorPrefix(content) {
  if (typeof content === 'string') return `Error: ${content}`
  if (!Array.isArray(content)) return content
  const index = content.findIndex((part) => part?.type === 'text')
  if (index === -1) return [{ type: 'text', text: 'Error: the tool failed without a text message' }, ...content]
  return content.map((part, i) => (i === index ? { ...part, text: `Error: ${part.text ?? ''}` } : part))
}

/**
 * Content projection for image-bearing roles. String content exactly as before
 * when nothing can be forwarded; a parts array only once an image actually
 * resolves, so text-only traffic stays byte-identical to the pre-vision wire.
 * @param resolveImage - (block) => { url } | { text } | undefined, see toWireMessages.
 */
function blocksToContent(blocks, resolveImage) {
  const list = blocksOf(blocks)
  const served = new Map()
  for (const block of list) {
    if (block.type === 'image') served.set(block, resolveImage?.(block))
  }
  const hasForwardable = [...served.values()].some((answer) => typeof answer?.url === 'string')
  if (!hasForwardable) {
    return blocksToText(list, resolveImage ? (block) => served.get(block) : undefined)
  }
  const parts = []
  let text = ''
  const flush = () => {
    if (text) {
      parts.push({ type: 'text', text })
      text = ''
    }
  }
  for (const block of list) {
    if (block.type === 'text') text += block.text ?? ''
    else if (block.type === 'file') text += FILE_PLACEHOLDER
    else if (block.type === 'image') {
      const answer = served.get(block)
      if (typeof answer?.url === 'string') {
        flush()
        parts.push({ type: 'image_url', image_url: { url: answer.url } })
      } else {
        text += imageText(block, answer)
      }
    }
    // reasoning/tool-call blocks are handled per-role elsewhere, never as content parts
  }
  flush()
  return parts
}

/**
 * @param options - dsh GenerateOptions (never mutated).
 * @param resolveImage - optional (block) => { url: string } to forward one
 * image block as a data URL, { text: string } to render it with honest text,
 * or undefined for the generic placeholder. Absent resolver = text-only bridge.
 * @returns {{ messages: object[], notice?: string }} fresh wire messages; a
 * leading one-shot `system` string becomes the first system message.
 */
export function toWireMessages(options, resolveImage) {
  const out = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    const blocks = blocksOf(message.content)
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: blocksToText(blocks, resolveImage) })
        break
      case 'user':
      case 'developer':
        // The wire has no developer role; instruction-shaped context stays model-visible as user text.
        out.push({ role: 'user', content: blocksToContent(blocks, resolveImage) })
        break
      case 'assistant': {
        let text = ''
        const reasoningParts = []
        const toolCalls = []
        for (const block of blocks) {
          if (block.type === 'text') text += block.text ?? ''
          else if (block.type === 'reasoning') reasoningParts.push(block.text ?? '')
          else if (block.type === 'tool-call') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: block.arguments ?? '' },
            })
          }
        }
        const wire = { role: 'assistant', content: text }
        if (reasoningParts.length > 0) wire.reasoning = reasoningParts.join('\n\n')
        if (toolCalls.length > 0) wire.tool_calls = toolCalls
        out.push(wire)
        break
      }
      case 'tool': {
        // Images in tool results (read_image, screenshots) forward as parts,
        // mirroring dsh's own pi-ai route, which admits user and tool images.
        const text = blocksToContent(blocks, resolveImage)
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.isError ? withErrorPrefix(text) : text,
        })
        break
      }
      default:
        // Unknown roles are merge-extensible upstream; forwarding a guessed shape would corrupt the history.
        break
    }
  }
  return { messages: out }
}

/** dsh ToolSchema[] → core RequestTool[] (`parameters` is the harness name for `inputSchema`). */
export function toRequestTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }))
}
