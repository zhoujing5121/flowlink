/**
 * FlowForge-compatible evidence archive layered beside FlowLink's executable Flow IR.
 * FlowLink remains the replay authority; this sidecar preserves the richer, ordered
 * capture/event model for inspection, semantic refinement and future replays.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Flow } from '../../schema/src/index.js'
import type { RawEvent } from './types.js'
import { FlowForgeRecordingSchema } from './flowforge-capture-schema.js'

export interface HostCaptureEvent { action: string; ts: number; tabId: string; url?: string; title?: string; openerTabId?: string; previousUrl?: string }

export interface CaptureTab {
  tabId: string
  url: string
  title: string
  active: boolean
  systemId: string
  systemName: string
  pageIndex: number
}

function systemFromUrl(raw = ''): { systemId: string; systemName: string; domain?: string } {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return { systemId: 'browser', systemName: 'Browser' }
    const hostname = url.hostname.toLowerCase()
    return { systemId: hostname.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown-system', systemName: hostname, domain: hostname }
  } catch {
    return { systemId: 'unknown-system', systemName: 'Unknown system' }
  }
}

function safeEvent(event: RawEvent, sequence: number, tabs: CaptureTab[]) {
  const tab = tabs.find(item => item.pageIndex === (event.pageIndex ?? 0))
  const url = event.frameUrl || event.url || tab?.url || ''
  const system = systemFromUrl(url)
  const facts = event.facts
  const data = { ...(event.data ?? {}) }
  // The executable Flow IR keeps the values needed for replay. The evidence archive
  // deliberately omits entered/select values to avoid duplicating personal data.
  if (event.kind === 'input' || event.kind === 'change') {
    delete data.value
    if (event.data?.value !== undefined) data.masked = true
  }
  const action = event.kind === 'navigation' ? 'navigate'
    : event.kind === 'input' ? 'fill'
    : event.kind === 'change' ? (event.data?.selectedValues ? 'selectOption' : 'change')
    : event.kind === 'keydown' ? 'press'
    : event.kind
  return {
    eventId: event.eventId || `flowlink-event-${sequence}`,
    sequence,
    action,
    recordedAt: new Date(event.ts).toISOString(),
    timestamp: event.ts,
    tabId: event.tabId || tab?.tabId || `page-${event.pageIndex ?? 0}`,
    pageIndex: event.pageIndex ?? 0,
    frameIndex: event.frameIndex ?? 0,
    systemId: event.systemId || system.systemId,
    systemName: event.systemName || system.systemName,
    url,
    title: tab?.title || '',
    navigationType: event.navigationType,
    previousUrl: event.previousUrl,
    navigationEvidence: event.navigationEvidence,
    trusted: Boolean(event.trusted),
    target: facts ? {
      tag: facts.tag,
      role: facts.role,
      accessibleName: facts.accessibleName,
      text: facts.text,
      labels: facts.labels || [],
      nearbyText: facts.nearbyText || [],
      attributes: facts.attributes || {},
      rect: facts.rect,
      scroll: facts.scroll,
      viewport: facts.viewport,
      dpr: facts.dpr,
      nodePath: facts.nodePath,
      shadowRootType: facts.shadowRootType,
      frameUrl: event.frameUrl
    } : undefined,
    data,
    beforeSnapshot: event.beforeSnapshot,
    afterSnapshot: event.afterSnapshot,
    flowStepId: event.flowStepId,
    locatorEvidence: event.locatorEvidence,
    evidence: {
      captureSource: 'flowlink-recorder',
      targetFactsCaptured: Boolean(facts),
      locatorResolution: facts?.validation || 'not-validated-in-raw-event',
      note: 'Executable locator candidates and verified fingerprints are retained in the FlowLink Flow IR.'
    }
  }
}

function semanticize(events: ReturnType<typeof safeEvent>[]) {
  let lastCopy: (typeof events)[number] | undefined
  return events.flatMap(event => {
    if (['userNavigateRequested', 'historyBackRequested', 'historyForwardRequested', 'reloadRequested', 'autoRedirect'].includes(event.action)) return []
    if (event.action === 'copy') lastCopy = event
    if (['pointerdown', 'hover', 'focus', 'blur', 'tabClosed'].includes(event.action)) return []
    const clipboard: { clipboardSourceEventId?: string; clipboardSourceTabId?: string; clipboardSourceSystemId?: string } = event.action === 'paste' && lastCopy ? {
      clipboardSourceEventId: lastCopy.eventId,
      clipboardSourceTabId: lastCopy.tabId,
      clipboardSourceSystemId: lastCopy.systemId
    } : {}
    const actionType = event.action === 'tabCreated' ? 'openTab' : event.action === 'tabActivated' ? 'systemSwitch' : event.action === 'navigate' ? (event.navigationType || 'unknown_navigation') : event.action
    const title = event.action === 'tabCreated' ? `Open tab · ${event.systemName}` : event.action === 'tabActivated' ? `Switch to ${event.systemName}` : event.action === 'navigate' ? `Navigate · ${event.navigationType || 'unknown'} · ${event.url}` : `${actionType} · ${event.target?.accessibleName || event.target?.text || event.target?.tag || event.systemName}`
    return [{
      id: `semantic-${event.sequence}`,
      sequence: event.sequence,
      actionType,
      title,
      description: `Captured ${actionType} on ${event.systemName} (${event.url})`,
      eventIds: [event.eventId],
      tabId: event.tabId,
      systemId: event.systemId,
      systemName: event.systemName,
      pageUrl: event.url,
      target: event.target,
      sourceSystems: [...new Set([event.systemId, clipboard.clipboardSourceSystemId].filter(Boolean))],
      ...clipboard
    }]
  })
}

export async function writeFlowForgeArchive(rawPath: string | undefined, flow: Flow, tabs: CaptureTab[], outputDir: string, hostEvents: HostCaptureEvent[] = []): Promise<string | undefined> {
  if (!rawPath) return undefined
  const raw = JSON.parse(await readFile(rawPath, 'utf8')) as { events?: RawEvent[]; warnings?: string[]; pages?: Array<{ index: number; url: string }> }
  const enrichedRawEvents = (raw.events || []).map((event) => {
    if (event.kind !== 'navigation') return event
    const hostIntent = hostEvents
      .filter((item) => Math.abs(item.ts - event.ts) <= 10_000 && (item.url === event.url || item.action === 'historyBackRequested' || item.action === 'historyForwardRequested' || item.action === 'reloadRequested'))
      .sort((a, b) => Math.abs(a.ts - event.ts) - Math.abs(b.ts - event.ts))[0]
    if (!hostIntent) return event
    if (hostIntent.action === 'userNavigateRequested') return { ...event, navigationType: 'user_navigate' as const, directNavigation: true, navigationEvidence: [...(event.navigationEvidence || []), 'electron-address-bar-navigation-request'] }
    if (hostIntent.action === 'autoRedirect') {
      const isAuth = (value = '') => /(^|\.)(login|logon|auth|sso|signin|identity|idp)(\.|$)|\/(login|logon|oauth|authorize|saml|signin|sso)([/?#]|$)/i.test(value)
      const type = isAuth(hostIntent.url || event.url || '') ? 'sso_redirect' : isAuth(hostIntent.previousUrl || event.previousUrl || '') ? 'login_redirect' : 'auto_redirect'
      return { ...event, navigationType: type as RawEvent['navigationType'], directNavigation: false, previousUrl: hostIntent.previousUrl || event.previousUrl, navigationEvidence: [...(event.navigationEvidence || []), 'electron-will-redirect-event'] }
    }
    if (hostIntent.action === 'historyBackRequested' || hostIntent.action === 'historyForwardRequested') return { ...event, navigationType: 'history_navigation' as const, directNavigation: true, navigationEvidence: [...(event.navigationEvidence || []), `electron-${hostIntent.action}`] }
    if (hostIntent.action === 'reloadRequested') return { ...event, navigationType: 'auto_redirect' as const, directNavigation: false, navigationEvidence: [...(event.navigationEvidence || []), 'electron-reload-request'] }
    return event
  })
  const events = enrichedRawEvents.map((event, index) => safeEvent(event, index + 1, tabs))
  for (const hostEvent of hostEvents) {
    const tab = tabs.find(item => item.tabId === hostEvent.tabId)
    const system = systemFromUrl(hostEvent.url || tab?.url || '')
    events.push({ eventId: `flowlink-host-${hostEvents.indexOf(hostEvent) + 1}`, sequence: 0, action: hostEvent.action, recordedAt: new Date(hostEvent.ts).toISOString(), timestamp: hostEvent.ts, tabId: hostEvent.tabId, pageIndex: tab?.pageIndex ?? -1, frameIndex: -1, systemId: system.systemId, systemName: system.systemName, url: hostEvent.url || tab?.url || '', title: hostEvent.title || tab?.title || '', trusted: true, target: { tag: 'document', text: hostEvent.title || '' }, data: {}, evidence: { captureSource: 'electron-host', targetFactsCaptured: false, locatorResolution: 'not-applicable' } } as (typeof events)[number])
  }
  events.sort((a, b) => a.timestamp - b.timestamp)
  events.forEach((event, index) => { event.sequence = index + 1 })
  const systems = [...new Map(tabs.map(tab => {
    const parsed = systemFromUrl(tab.url)
    return [tab.systemId, { systemId: tab.systemId, name: tab.systemName, domains: parsed.domain ? [parsed.domain] : [] }]
  })).values()]
  const archive = {
    schema: 'flowforge.recording.v1',
    source: { application: 'FlowLink', recorderCompatibility: 'FlowForge 0.4 event/evidence model' },
    recordingId: flow.id,
    workflowTitle: flow.title,
    startedAt: flow.createdAt,
    stoppedAt: new Date().toISOString(),
    initialUrl: flow.meta.env.startUrl,
    finalUrl: tabs.find(tab => tab.active)?.url || tabs.at(-1)?.url || flow.meta.env.startUrl,
    tabs,
    systems,
    warnings: raw.warnings || [],
    events,
    semanticSteps: semanticize(events),
    executableFlow: { schemaVersion: flow.schemaVersion, id: flow.id, stepIds: flow.steps.map(step => step.id) },
    replayAuthority: 'FlowLink Flow IR; this archive is immutable capture evidence and semantic metadata.'
  }
  const dir = join(outputDir, 'record')
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'flowforge-recording.json')
  const validated = FlowForgeRecordingSchema.parse(archive)
  await writeFile(target, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
  return target
}
