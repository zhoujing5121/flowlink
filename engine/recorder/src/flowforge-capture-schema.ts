/** FlowForge 0.4-compatible capture/event archive contract, expressed with FlowLink's Zod 3 dependency. */
import { z } from 'zod'
import { CandidateSchema } from '../../schema/src/schema.js'

export const FlowForgeTargetSchema = z.object({
  tag: z.string().optional(), role: z.string().optional(), accessibleName: z.string().optional(),
  text: z.string().optional(), labels: z.array(z.string()).default([]), nearbyText: z.array(z.string()).default([]),
  attributes: z.record(z.string()).default({}),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  scroll: z.object({ x: z.number(), y: z.number() }).optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  dpr: z.number().optional(), nodePath: z.array(z.number()).optional(),
  shadowRootType: z.enum(['open', 'closed']).optional(), frameUrl: z.string().optional()
}).passthrough()

const FlowForgeSnapshotSchema = z.object({
  url: z.string(),
  nodes: z.array(z.object({ key: z.string(), tag: z.string(), text: z.string(), rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional() }).passthrough())
}).passthrough()

export const FlowForgeCaptureEventSchema = z.object({
  eventId: z.string(), sequence: z.number().int().positive(), action: z.string(),
  recordedAt: z.string(), timestamp: z.number(), tabId: z.string(), pageIndex: z.number().int(),
  frameIndex: z.number().int(), systemId: z.string(), systemName: z.string(),
  url: z.string(), title: z.string(), trusted: z.boolean(), navigationType: z.string().optional(), previousUrl: z.string().optional(), navigationEvidence: z.array(z.string()).optional(), target: FlowForgeTargetSchema.optional(),
  data: z.record(z.unknown()).default({}),
  beforeSnapshot: FlowForgeSnapshotSchema.optional(), afterSnapshot: FlowForgeSnapshotSchema.optional(),
  flowStepId: z.string().optional(), locatorEvidence: z.array(CandidateSchema).optional(),
  evidence: z.object({ captureSource: z.string(), targetFactsCaptured: z.boolean(), locatorResolution: z.string() }).passthrough()
}).passthrough()

export const FlowForgeRecordingSchema = z.object({
  schema: z.literal('flowforge.recording.v1'),
  source: z.object({ application: z.string(), recorderCompatibility: z.string() }),
  recordingId: z.string(), workflowTitle: z.string(), startedAt: z.string(), stoppedAt: z.string(),
  initialUrl: z.string(), finalUrl: z.string(),
  tabs: z.array(z.object({ tabId: z.string(), url: z.string(), title: z.string(), active: z.boolean(), systemId: z.string(), systemName: z.string(), pageIndex: z.number().int() })),
  systems: z.array(z.object({ systemId: z.string(), name: z.string(), domains: z.array(z.string()) })),
  warnings: z.array(z.string()), events: z.array(FlowForgeCaptureEventSchema),
  semanticSteps: z.array(z.record(z.unknown())),
  executableFlow: z.object({ schemaVersion: z.number(), id: z.string(), stepIds: z.array(z.string()) }),
  replayAuthority: z.string()
}).passthrough()
