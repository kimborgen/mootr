// The blocking line on an ask (askBlock): under the ask's bar, and as the short suffix of its Mail row.
import { useData, permThread } from '../store'
import { askBlock, askBlockText } from './askBlock'

export function AskBlockLine({ thread, short }: { thread: string | null | undefined; short?: boolean }) {
  const data = useData()
  const text = askBlockText(askBlock(thread, data, permThread), short)
  return text ? <span className="ask-block" data-ask-block>{text}</span> : null
}
