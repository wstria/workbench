import { Component, createRef } from 'react'
import { TabsList } from '@/components/ui/tabs'

const slide = { duration: 170, easing: 'cubic-bezier(.22,.7,.25,1)' }
const release = { duration: 115, easing: 'ease-out' }

export class TabStrip extends Component {
  region = createRef()
  ghosts = createRef()
  animations = new Map()

  getSnapshotBeforeUpdate(previous) {
    const { listRef, order, active, trailing } = this.props
    if ((order === previous.order && active === previous.active && trailing === previous.trailing) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null
    const region = this.region.current.getBoundingClientRect()
    const tabs = new Map()
    const closing = []
    const remaining = new Set(order.split(','))
    for (const tab of listRef.current.children) {
      const rect = tab.getBoundingClientRect()
      if (rect.right <= region.left || rect.left >= region.right) continue
      const { tabId } = tab.dataset
      tabs.set(tabId, rect.left)
      if (!remaining.has(tabId)) {
        closing.push({ tab: tab.cloneNode(true), offset: rect.left - region.left, top: rect.top - region.top,
          width: rect.width, height: rect.height })
      }
    }
    return { tabs, closing, added: new Set(order.split(',').filter((id) => !previous.order.split(',').includes(id))) }
  }

  componentDidUpdate(_, __, snapshot) {
    if (!snapshot) return
    const { listRef } = this.props
    const region = this.region.current.getBoundingClientRect()
    for (const animation of this.animations.values()) animation.cancel()
    this.animations.clear()
    // Measure destination geometry before moving any tab.
    const positions = Array.from(listRef.current.children, (tab) => [tab, tab.getBoundingClientRect()])
    for (const [tab, rect] of positions) {
      if (rect.right <= region.left || rect.left >= region.right) continue
      const { tabId } = tab.dataset
      const previous = snapshot.tabs.get(tabId)
      let motion
      if (previous !== undefined && Math.abs(previous - rect.left) > .5) {
        motion = tab.animate([{ transform: 'translateX(' + (previous - rect.left) + 'px)' }, { transform: 'none' }], slide)
      } else if (snapshot.added.has(tabId)) {
        motion = tab.animate([{ opacity: .38, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], slide)
      }
      if (motion) {
        this.animations.set(tab, motion)
        motion.onfinish = () => { if (this.animations.get(tab) === motion) this.animations.delete(tab) }
      }
    }
    for (const item of snapshot.closing) {
      const tab = item.tab
      tab.classList.add('tab-ghost')
      for (const element of tab.querySelectorAll('[id]')) element.removeAttribute('id')
      Object.assign(tab.style, { left: item.offset + 'px', top: item.top + 'px', width: item.width + 'px', height: item.height + 'px', minWidth: '0' })
      this.ghosts.current.append(tab)
      const motion = tab.animate([{ opacity: .65 }, { opacity: 0, transform: 'translateY(-3px) scale(.98)' }], release)
      motion.onfinish = () => tab.remove()
    }
  }

  componentWillUnmount() {
    for (const animation of this.animations.values()) animation.cancel()
  }

  render() {
    return <div className="tab-region" ref={this.region}>
      <TabsList ref={this.props.listRef} className="tab-strip" aria-label="Open tabs" onWheel={(event) => {
        const list = event.currentTarget
        if (Math.abs(event.deltaX) < Math.abs(event.deltaY) && list.scrollWidth > list.clientWidth) list.scrollLeft += event.deltaY
      }}>
        {this.props.children}
      </TabsList>
      <div ref={this.ghosts} className="tab-ghosts" aria-hidden="true" inert />
    </div>
  }
}
