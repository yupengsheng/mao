import { createApp, defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.hoisted(() => vi.fn())

vi.mock('../../../api', () => ({
  api: {
    get,
    put: vi.fn(),
  },
}))

import ContainerHostsPanel from './ContainerHostsPanel.vue'

const passthrough = defineComponent({
  inheritAttrs: false,
  setup(_, { slots }) {
    return () => h('div', slots.default?.())
  },
})

const tableStub = defineComponent({
  props: { data: { type: Array, default: () => [] } },
  setup(props) {
    return () => h('div', {
      'data-testid': 'preview-table',
      'data-row-count': String(Array.isArray(props.data) ? props.data.length : -1),
    })
  },
})

function mountPanel() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ContainerHostsPanel, { canWrite: false })
  for (const name of [
    'el-card', 'el-button', 'el-alert', 'el-switch', 'el-empty', 'el-divider',
    'el-dialog', 'el-form', 'el-form-item', 'el-input',
  ]) app.component(name, passthrough)
  app.component('el-table', tableStub)
  app.component('el-table-column', passthrough)
  app.mount(host)
  return { app, host }
}

describe('ContainerHostsPanel preview response', () => {
  beforeEach(() => get.mockReset())
  afterEach(() => document.body.innerHTML = '')

  it('only passes an entries array to the table when the response shape is valid', async () => {
    get.mockResolvedValue({ data: { entries: { unexpected: true } } })
    const { app, host } = mountPanel()
    await Promise.resolve()
    await nextTick()

    expect(host.querySelector('[data-testid="preview-table"]')?.getAttribute('data-row-count')).toBe('0')
    app.unmount()
  })

  it('keeps valid preview entries', async () => {
    get.mockResolvedValue({ data: { entries: [{ host: 'example.test', ip: '10.0.0.1', source: 'custom' }] } })
    const { app, host } = mountPanel()
    await Promise.resolve()
    await nextTick()

    expect(host.querySelector('[data-testid="preview-table"]')?.getAttribute('data-row-count')).toBe('1')
    app.unmount()
  })
})
