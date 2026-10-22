import { createDemoSnapshot } from '../data/fixtures';
import { surveyRecommendation, validSurvey, type HouseSurveyDraft } from '../domain/setup';
import { canManageSensors } from '../domain/policy';
import type { FarmSnapshot, PreviewContext, Role, Section, Sensor } from '../domain/types';
import {
  buildInstallationPlan,
  checklistComplete,
  commissioningChecks,
  emptySiteWorkflow,
  installationChecks,
  trialChecks,
  validSiteSurvey,
  validSiteWorkflow,
  workflowFromLegacyHouse,
  workflowFromSurvey,
  type ChecklistValue,
  type CommissioningCheck,
  type InstallationCheck,
  type SiteSurvey,
  type SiteWorkflow,
  type TrialCheck,
} from '../domain/siteWorkflow';
import { DemoFarmService } from './demoFarmService';
import { cacheSnapshot, validSnapshot, type KeyValueStorage } from './snapshotCache';
import {
  deviceSetupProgress,
  emptyDeviceSimulation,
  parsePairingQr,
  recordDeviceEvent,
  snapshotForDeviceSimulation,
  validDeviceSimulation,
  type DeviceSimulation,
} from '../domain/deviceSimulation';
import { houseGrid, positionInSection, sectionAtPosition } from '../domain/houseLayout';

export const LOCAL_FARM_KEY = 'coopguard.localFarm.v1';
export interface FlockCycle {
  id: string;
  startDate: string;
  days: number;
  birds: number;
  endedAt?: number;
  alertCount?: number;
}
export interface Inspection {
  pending?: boolean;
  authorId?: string;
  authorName?: string;
  id: string;
  kind: 'environment' | 'sound';
  text: string;
  createdAt: number;
}
export interface LocalFarmState {
  version: 1;
  started: boolean;
  snapshot: FarmSnapshot;
  context: PreviewContext;
  house: HouseSurveyDraft | null;
  site: SiteWorkflow;
  notifications: boolean;
  aiState: 'collecting' | 'unavailable';
  flock: FlockCycle | null;
  pastFlocks: FlockCycle[];
  inspections: Inspection[];
  people: { id: string; name: string; role: Role }[];
  retired: Sensor[];
  calibration: Record<string, number>;
  deviceSimulation: DeviceSimulation;
}
export type LocalAction =
  | {
      type:
        | 'start'
        | 'welcome'
        | 'restore'
        | 'tick'
        | 'refresh'
        | 'reconnect'
        | 'fullPower'
        | 'endFlock';
    }
  | { type: 'context'; patch: Partial<PreviewContext> }
  | { type: 'ai'; value: LocalFarmState['aiState'] }
  | { type: 'notifications'; value: boolean }
  | { type: 'house'; value: HouseSurveyDraft; open?: boolean }
  | { type: 'saveSiteSurvey'; value: SiteSurvey }
  | {
      type: 'approveSitePlan' | 'startInstallation' | 'beginCommissioning' | 'startMonitoringTrial';
    }
  | {
      type: 'siteChecklist';
      stage: 'installation' | 'commissioning' | 'trial';
      key: InstallationCheck | CommissioningCheck | TrialCheck;
      value: ChecklistValue;
    }
  | { type: 'activateSite'; mode: 'monitor' | 'full' }
  | { type: 'createVirtualHub'; farmCode: string }
  | {
      type: 'createVirtualNode';
      farmCode: string;
      section: Section;
    }
  | { type: 'pairVirtualDevice'; qr: string }
  | { type: 'removeVirtualDevice'; id: string }
  | { type: 'updateVirtualFirmware'; id: string }
  | { type: 'ack'; id: string }
  | { type: 'addSensor'; section: Section; control: boolean; tested: boolean; calibrated: boolean }
  | { type: 'moveSensor'; id: string; section: Section; x: number; y: number }
  | { type: 'retireSensor' | 'calibrate'; id: string }
  | { type: 'startFlock'; startDate: string; days: number; birds: number }
  | { type: 'saveInspection'; id?: string; kind: Inspection['kind']; text: string }
  | { type: 'deleteInspection' | 'deletePerson'; id: string }
  | { type: 'savePerson'; id?: string; name: string; role: Role };

export function dateText(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dateText(date.getTime()) === value;
}
export function flockDay(flock: FlockCycle, now: number) {
  const today = new Date(dateText(now)).getTime();
  return Math.max(1, Math.floor((today - new Date(flock.startDate).getTime()) / 86_400_000) + 1);
}
export function seedLocalFarm(now = Date.now()): LocalFarmState {
  return {
    version: 1,
    started: false,
    snapshot: createDemoSnapshot(now),
    context: { connection: 'local', role: 'owner', controlMode: 'full' },
    house: null,
    site: emptySiteWorkflow(now),
    notifications: true,
    aiState: 'collecting',
    flock: { id: 'flock-1', startDate: dateText(now - 17 * 86_400_000), days: 42, birds: 1000 },
    pastFlocks: [],
    inspections: [],
    retired: [],
    calibration: {},
    deviceSimulation: emptyDeviceSimulation(),
    people: [{ id: 'owner', name: 'Farm owner', role: 'owner' }],
  };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const roles = ['owner', 'worker', 'technician'];
const layoutForState = (state: LocalFarmState) => {
  const house = state.site.survey?.house ?? state.house;
  return houseGrid(house?.lengthMetres ?? 90, house?.widthMetres ?? 12);
};
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, limit = 80): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
function validFlock(value: FlockCycle) {
  return (
    value &&
    text(value.id) &&
    validDate(value.startDate) &&
    Number.isInteger(value.days) &&
    value.days > 0 &&
    value.days <= 730 &&
    Number.isInteger(value.birds) &&
    value.birds > 0 &&
    value.birds <= 1_000_000 &&
    (value.endedAt === undefined || finite(value.endedAt)) &&
    (value.alertCount === undefined || finite(value.alertCount))
  );
}
export function validLocalFarm(value: unknown): value is LocalFarmState {
  try {
    const s = value as LocalFarmState;
    if (
      !s ||
      s.version !== 1 ||
      typeof s.started !== 'boolean' ||
      !validSnapshot(cacheSnapshot(s.snapshot))
    )
      return false;
    if (
      !s.context ||
      !roles.includes(s.context.role) ||
      !['local', 'cloud', 'offline'].includes(s.context.connection) ||
      !['full', 'monitor'].includes(s.context.controlMode)
    )
      return false;
    if (s.house !== null && !validSurvey(s.house)) return false;
    if (!s.site) s.site = s.house ? workflowFromLegacyHouse(s.house) : emptySiteWorkflow();
    if (!s.deviceSimulation) s.deviceSimulation = emptyDeviceSimulation();
    if (!validSiteWorkflow(s.site)) return false;
    if (!validDeviceSimulation(s.deviceSimulation)) return false;
    if (typeof s.notifications !== 'boolean' || !['collecting', 'unavailable'].includes(s.aiState))
      return false;
    const request = s.snapshot.request;
    if (
      request &&
      (!text(request.id) ||
        !['pending', 'applied', 'expired', 'rejected'].includes(request.status) ||
        !finite(request.requestedAt) ||
        !finite(request.expiresAt) ||
        request.expiresAt <= request.requestedAt ||
        (request.status === 'applied' &&
          (!finite(request.appliedAt) || !finite(request.overrideExpiresAt))) ||
        (request.overrideExpiresAt !== undefined && !finite(request.overrideExpiresAt)))
    )
      return false;
    if (s.flock !== null && !validFlock(s.flock)) return false;
    if (
      !Array.isArray(s.pastFlocks) ||
      s.pastFlocks.length > 1000 ||
      !s.pastFlocks.every(validFlock)
    )
      return false;
    if (
      !Array.isArray(s.inspections) ||
      s.inspections.length > 1000 ||
      !s.inspections.every(
        (n) =>
          text(n.id) &&
          ['environment', 'sound'].includes(n.kind) &&
          text(n.text, 2000) &&
          finite(n.createdAt),
      )
    )
      return false;
    if (
      !Array.isArray(s.people) ||
      !s.people.length ||
      s.people.length > 100 ||
      !s.people.every((p) => text(p.id) && text(p.name) && roles.includes(p.role)) ||
      !s.people.some((p) => p.role === 'owner')
    )
      return false;
    if (
      !Array.isArray(s.retired) ||
      !validSnapshot({ ...cacheSnapshot(s.snapshot), sensors: s.retired })
    )
      return false;
    if (
      !s.calibration ||
      typeof s.calibration !== 'object' ||
      Array.isArray(s.calibration) ||
      !Object.values(s.calibration).every(finite)
    )
      return false;
    const ids = [...s.snapshot.sensors, ...s.retired].map((n) => n.id);
    return (
      new Set(ids).size === ids.length &&
      [...s.snapshot.sensors, ...s.retired].every((n) => /^\d{2,4}$/.test(n.number))
    );
  } catch {
    return false;
  }
}

/** Single local dummy-data store. Commit to disk before reporting an action as saved. */
export class LocalFarmRepository {
  private state: LocalFarmState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: KeyValueStorage,
    private clock = () => Date.now(),
    private options: { deviceSetupReady?: boolean } = {},
  ) {
    this.state = seedLocalFarm(clock());
  }
  async load() {
    const raw = await this.storage.getItem(LOCAL_FARM_KEY);
    if (raw) {
      let saved: unknown;
      try {
        saved = raw.length <= 4_000_000 ? JSON.parse(raw) : null;
      } catch {
        saved = null;
      }
      if (!validLocalFarm(saved))
        throw new Error('Saved farm data could not be read. It has not been overwritten.');
      this.state = saved;
    }
    return this.dispatch({ type: 'restore' });
  }
  dispatch(action: LocalAction): Promise<LocalFarmState> {
    const result = this.queue.then(async () => {
      const next = clone(this.state);
      await this.reduce(next, action);
      if (!validLocalFarm(next)) throw new Error('The change contains invalid data.');
      if (JSON.stringify(next) !== JSON.stringify(this.state) || action.type === 'start') {
        const encoded = JSON.stringify(next);
        if (encoded.length > 4_000_000)
          throw new Error(
            'Local storage limit reached. Export and remove old inspection notes before saving more.',
          );
        await this.storage.setItem(LOCAL_FARM_KEY, encoded);
        this.state = next;
      }
      return clone(this.state);
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async reduce(s: LocalFarmState, a: LocalAction) {
    const now = this.clock();
    const id = (prefix: string) => `${prefix}-${now}-${Math.random().toString(36).slice(2, 9)}`;
    const engine = new DemoFarmService(this.clock, s.snapshot);
    const requireManager = () => {
      if (s.context.role === 'worker')
        throw new Error('An owner or technician must make this change.');
    };
    const requireTechnician = () => {
      if (!canManageSensors(s.context))
        throw new Error('Choose Technician and At the farm in Sample settings.');
    };
    const requireTechnicianRole = () => {
      if (s.context.role !== 'technician')
        throw new Error('Only a technician can complete this work.');
    };
    switch (a.type) {
      case 'start':
        s.started = true;
        break;
      case 'welcome':
        s.started = false;
        break;
      case 'context':
        s.context = { ...s.context, ...a.patch };
        if (s.house && surveyRecommendation(s.house) !== 'eligible')
          s.context.controlMode = 'monitor';
        break;
      case 'notifications':
        s.notifications = a.value;
        break;
      case 'ai':
        s.aiState = a.value;
        break;
      case 'house':
        requireManager();
        if (!validSurvey(a.value)) throw new Error('Check the house details.');
        // The example flock must not become the user's first flock by implication.
        if (!s.house && s.flock?.id === 'flock-1') s.flock = null;
        s.house = a.value;
        s.site = workflowFromLegacyHouse(a.value, now);
        if (a.open) s.started = true;
        s.context.controlMode = surveyRecommendation(a.value) === 'eligible' ? 'full' : 'monitor';
        if (s.context.controlMode === 'monitor') {
          s.snapshot.request = null;
          s.snapshot.fanStage = 'high';
        }
        break;
      case 'saveSiteSurvey': {
        requireTechnicianRole();
        if (!validSiteSurvey(a.value)) throw new Error('Complete the required survey questions.');
        const survey = { ...a.value, completedAt: now };
        s.site = workflowFromSurvey(survey, now);
        s.house = {
          farmName: survey.farm.farmName,
          houseName: survey.farm.houseName,
          houseType:
            survey.house.type === 'open' || survey.house.type === 'tunnel'
              ? survey.house.type
              : 'unknown',
          controller: survey.controller.status,
          flock:
            survey.flock.type === 'broiler' || survey.flock.type === 'layer'
              ? survey.flock.type
              : 'unknown',
          lengthMetres: survey.house.lengthMetres,
          widthMetres: survey.house.widthMetres,
        };
        s.context.controlMode = 'monitor';
        s.snapshot.request = null;
        s.snapshot.fanStage = 'high';
        break;
      }
      case 'approveSitePlan':
        requireTechnicianRole();
        if (s.site.status !== 'review_required' || !s.site.survey)
          throw new Error('Complete the site survey before approving the plan.');
        s.site.plan = buildInstallationPlan(s.site.survey, now);
        if (s.site.plan.blockers.length)
          throw new Error(`Resolve first: ${s.site.plan.blockers[0]}`);
        s.site.status = 'approved_install';
        s.site.updatedAt = now;
        break;
      case 'startInstallation':
        requireTechnicianRole();
        if (s.site.status !== 'approved_install')
          throw new Error('Approve the installation plan first.');
        s.site.status = 'installing';
        s.site.updatedAt = now;
        break;
      case 'beginCommissioning':
        requireTechnicianRole();
        if (
          s.site.status !== 'installing' ||
          !checklistComplete(s.site.installation, installationChecks)
        )
          throw new Error('Complete every required installation check first.');
        if (
          !(this.options.deviceSetupReady ?? deviceSetupProgress(s.site, s.deviceSimulation).ready)
        )
          throw new Error('Pair the planned hub and sensor nodes before commissioning.');
        s.site.status = 'commissioning';
        s.site.updatedAt = now;
        break;
      case 'startMonitoringTrial':
        requireTechnicianRole();
        if (
          s.site.status !== 'commissioning' ||
          !checklistComplete(s.site.commissioning, commissioningChecks)
        )
          throw new Error('Complete every required commissioning check first.');
        s.site.status = 'monitoring_trial';
        s.site.trialStartedAt = now;
        s.site.updatedAt = now;
        break;
      case 'siteChecklist': {
        requireTechnicianRole();
        const definitions =
          a.stage === 'installation'
            ? installationChecks
            : a.stage === 'commissioning'
              ? commissioningChecks
              : trialChecks;
        const expectedStatus =
          a.stage === 'installation'
            ? 'installing'
            : a.stage === 'commissioning'
              ? 'commissioning'
              : 'monitoring_trial';
        if (s.site.status !== expectedStatus) throw new Error('This checklist is not active yet.');
        const definition = definitions.find(([key]) => key === a.key);
        if (!definition || (a.value === 'na' && !definition[2]))
          throw new Error('Choose a valid checklist result.');
        if (
          a.value === 'na' &&
          s.site.plan?.recommendedMode === 'full_candidate' &&
          ['wiringCompleted', 'equipmentMapped', 'actuatorTests', 'fallbackTests'].includes(a.key)
        )
          throw new Error('A full-control candidate must pass this check; it cannot be N/A.');
        (s.site[a.stage] as Record<string, ChecklistValue>)[a.key] = a.value;
        s.site.updatedAt = now;
        break;
      }
      case 'activateSite':
        requireTechnicianRole();
        if (s.site.status !== 'monitoring_trial' || !checklistComplete(s.site.trial, trialChecks))
          throw new Error('Complete the monitoring trial checks first.');
        if (
          !(this.options.deviceSetupReady ?? deviceSetupProgress(s.site, s.deviceSimulation).ready)
        )
          throw new Error('The planned hub and nodes must be paired and reporting.');
        if (a.mode === 'full' && s.site.plan?.recommendedMode !== 'full_candidate')
          throw new Error('This site is approved for monitor-only operation.');
        s.site.status = a.mode === 'full' ? 'normal_control' : 'normal_monitor';
        s.site.activatedMode = a.mode;
        s.site.updatedAt = now;
        s.context.controlMode = a.mode;
        break;
      case 'createVirtualHub': {
        requireTechnicianRole();
        if (!s.site.survey || !s.site.plan)
          throw new Error('Complete the survey before creating the farm hub.');
        if (s.deviceSimulation.hub?.status === 'reporting')
          throw new Error('Remove the paired virtual hub before creating another one.');
        const suffix = Math.random().toString(36).slice(2, 10).toUpperCase();
        s.deviceSimulation.hub = {
          id: `HUB-${suffix}`,
          farmCode: a.farmCode,
          pairingCode: Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(12, '0'),
          status: 'created',
          createdAt: now,
          firmwareVersion: '0.1.0-sim',
        };
        s.deviceSimulation.nodes = [];
        break;
      }
      case 'createVirtualNode': {
        requireTechnicianRole();
        const hub = s.deviceSimulation.hub;
        if (!hub || hub.status !== 'reporting')
          throw new Error('Pair the virtual hub before creating nodes.');
        const layout = layoutForState(s);
        if (!layout.sections.includes(a.section)) throw new Error('Choose a valid house section.');
        const position = s.deviceSimulation.nodes.filter(
          (node) => node.section === a.section,
        ).length;
        const placement = positionInSection(a.section, layout, position, position + 1);
        const suffix = Math.random().toString(36).slice(2, 10).toUpperCase();
        s.deviceSimulation.nodes.push({
          id: `NODE-${suffix}`,
          farmCode: a.farmCode,
          pairingCode: Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(12, '0'),
          section: a.section,
          x: placement.x,
          y: placement.y,
          status: 'created',
          createdAt: now,
          firmwareVersion: '0.1.0-sim',
        });
        break;
      }
      case 'pairVirtualDevice': {
        requireTechnicianRole();
        const payload = parsePairingQr(a.qr);
        if (payload.kind === 'hub') {
          const hub = s.deviceSimulation.hub;
          if (
            !hub ||
            hub.id !== payload.deviceId ||
            hub.farmCode !== payload.farmCode ||
            hub.pairingCode !== payload.pairingCode
          )
            throw new Error('This hub QR does not belong to the selected farm.');
          Object.assign(hub, { status: 'reporting', pairedAt: now });
        } else {
          const hub = s.deviceSimulation.hub;
          const node = s.deviceSimulation.nodes.find((item) => item.id === payload.deviceId);
          if (
            !hub ||
            hub.status !== 'reporting' ||
            !node ||
            node.farmCode !== payload.farmCode ||
            node.pairingCode !== payload.pairingCode
          )
            throw new Error('This node QR does not belong to the selected farm or hub.');
          Object.assign(node, { status: 'reporting', pairedAt: now, hubId: hub.id });
        }
        break;
      }
      case 'removeVirtualDevice': {
        requireTechnicianRole();
        const removingHub = s.deviceSimulation.hub?.id === a.id;
        if (removingHub && ['normal_monitor', 'normal_control'].includes(s.site.status))
          throw new Error('The active farm hub cannot be removed. Replace or deactivate it first.');
        if (removingHub) {
          s.deviceSimulation = emptyDeviceSimulation();
        } else {
          const count = s.deviceSimulation.nodes.length;
          s.deviceSimulation.nodes = s.deviceSimulation.nodes.filter((node) => node.id !== a.id);
          if (count === s.deviceSimulation.nodes.length)
            throw new Error('The virtual device was not found.');
        }
        break;
      }
      case 'updateVirtualFirmware': {
        requireTechnicianRole();
        const device =
          s.deviceSimulation.hub?.id === a.id
            ? s.deviceSimulation.hub
            : s.deviceSimulation.nodes.find((node) => node.id === a.id);
        if (!device || device.status !== 'reporting')
          throw new Error('Only a reporting device can receive a simulated firmware update.');
        const version = device.firmwareVersion ?? '0.1.0-sim';
        const parts = version.match(/^(\d+)\.(\d+)\.(\d+)/);
        const nextVersion = parts
          ? `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}-sim`
          : '0.1.1-sim';
        device.firmwareVersion = nextVersion;
        device.firmwareUpdatedAt = now;
        recordDeviceEvent(s.deviceSimulation, {
          id: id('device-history'),
          deviceId: a.id,
          action: 'firmware_updated',
          details: `Simulated firmware updated to ${nextVersion}.`,
          createdAt: now,
        });
        break;
      }
      case 'ack':
        s.snapshot = await engine.acknowledge(a.id, s.context);
        break;
      case 'fullPower':
        if (s.site.status !== 'normal_control')
          throw new Error('Full-power control is locked until control commissioning is approved.');
        s.snapshot = await engine.requestFullPower(s.context);
        break;
      case 'reconnect':
        s.context.connection = 'local';
        s.snapshot = await engine.simulateReconnect(s.context);
        break;
      case 'refresh':
        if (s.context.connection !== 'local')
          throw new Error('Choose At the farm to request a new dummy reading.');
        s.snapshot.sampledAt = now;
        break;
      case 'restore':
      case 'tick':
        // Upgrade profiles saved by 0.1.0 without carrying its untouched demo flock
        // into the user's house. User-created cycles have distinct IDs and stay intact.
        if (a.type === 'restore' && s.house && s.flock?.id === 'flock-1') s.flock = null;
        s.snapshot = engine.tick();
        break;
      case 'addSensor': {
        requireTechnician();
        if (s.site.survey)
          throw new Error(
            'Add a surveyed-farm node through hub pairing, not the sample sensor form.',
          );
        if (
          s.site.status !== 'not_started' &&
          ![
            'installing',
            'commissioning',
            'monitoring_trial',
            'normal_monitor',
            'normal_control',
          ].includes(s.site.status)
        )
          throw new Error('Approve the plan and start installation before adding nodes.');
        const layout = layoutForState(s);
        if (
          !layout.sections.includes(a.section) ||
          !a.calibrated ||
          (a.control && (!a.tested || s.context.controlMode !== 'full'))
        )
          throw new Error('Complete the sensor checks first.');
        const number = String(
          Math.max(
            0,
            ...s.snapshot.sensors.map((n) => Number(n.number)),
            ...s.retired.map((n) => Number(n.number)),
          ) + 1,
        ).padStart(2, '0');
        const sample = createDemoSnapshot(now).sensors[0]!;
        s.snapshot.sensors.push({
          ...sample,
          id: `sensor-${number}`,
          number,
          section: a.section,
          ...positionInSection(a.section, layout),
          control: a.control,
        });
        s.calibration[`sensor-${number}`] = now;
        break;
      }
      case 'moveSensor': {
        if (s.site.survey) requireTechnicianRole();
        else requireTechnician();
        const sensor = s.snapshot.sensors.find((n) => n.id === a.id);
        const layout = layoutForState(s);
        if (
          !sensor ||
          !layout.sections.includes(a.section) ||
          !finite(a.x) ||
          !finite(a.y) ||
          a.x < 0 ||
          a.x > 1 ||
          a.y < 0 ||
          a.y > 1 ||
          sectionAtPosition(a.x, a.y, layout) !== a.section
        )
          throw new Error('Choose a position inside the selected section.');
        Object.assign(sensor, { section: a.section, x: a.x, y: a.y });
        const node = s.deviceSimulation.nodes.find((item) => item.id === a.id);
        if (node) {
          Object.assign(node, { section: a.section, x: a.x, y: a.y });
          recordDeviceEvent(s.deviceSimulation, {
            id: id('device-history'),
            deviceId: node.id,
            action: 'configured',
            details: `Node placement saved in Section ${a.section}.`,
            createdAt: now,
          });
        }
        break;
      }
      case 'retireSensor': {
        requireTechnician();
        const sensor = s.snapshot.sensors.find((n) => n.id === a.id);
        if (!sensor) throw new Error('Sensor already removed.');
        if (s.snapshot.sensors.length === 1)
          throw new Error('Keep at least one sensor in the sample house.');
        s.retired.push(sensor);
        s.snapshot.sensors = s.snapshot.sensors.filter((n) => n.id !== a.id);
        s.deviceSimulation.nodes = s.deviceSimulation.nodes.filter((node) => node.id !== a.id);
        break;
      }
      case 'calibrate':
        if (s.site.survey) requireTechnicianRole();
        else requireTechnician();
        if (
          !['commissioning', 'monitoring_trial', 'normal_monitor', 'normal_control'].includes(
            s.site.status,
          )
        )
          throw new Error('Calibration becomes available during commissioning.');
        if (!s.snapshot.sensors.some((n) => n.id === a.id && n.online))
          throw new Error('Choose a reporting sensor.');
        s.calibration[a.id] = now;
        if (s.deviceSimulation.nodes.some((node) => node.id === a.id))
          recordDeviceEvent(s.deviceSimulation, {
            id: id('device-history'),
            deviceId: a.id,
            action: 'calibrated',
            details: 'Simulated sensor calibration recorded.',
            createdAt: now,
          });
        break;
      case 'startFlock':
        requireManager();
        if (s.flock) throw new Error('End the current flock before starting another.');
        if (!validDate(a.startDate) || a.startDate > dateText(now))
          throw new Error('Use a valid start date no later than today (YYYY-MM-DD).');
        s.flock = { id: id('flock'), startDate: a.startDate, days: a.days, birds: a.birds };
        break;
      case 'endFlock':
        requireManager();
        if (!s.flock) throw new Error('There is no active flock.');
        s.pastFlocks.unshift({
          ...s.flock,
          endedAt: now,
          alertCount: s.snapshot.alerts.filter(
            (a) => a.detectedAt >= new Date(`${s.flock!.startDate}T00:00:00`).getTime(),
          ).length,
        });
        s.flock = null;
        break;
      case 'saveInspection': {
        if (!text(a.text.trim(), 2000))
          throw new Error('Enter an inspection note (up to 2,000 characters).');
        const old = s.inspections.find((n) => n.id === a.id);
        if (a.id && !old) throw new Error('This note no longer exists.');
        const note = {
          ...old,
          id: old?.id ?? id('note'),
          kind: a.kind,
          text: a.text.trim(),
          createdAt: old?.createdAt ?? now,
        };
        s.inspections = [note, ...s.inspections.filter((n) => n.id !== note.id)];
        break;
      }
      case 'deleteInspection':
        s.inspections = s.inspections.filter((n) => n.id !== a.id);
        break;
      case 'savePerson': {
        if (s.context.role !== 'owner') throw new Error('Only the owner can manage the team.');
        if (!text(a.name.trim())) throw new Error('Enter a name (up to 80 characters).');
        if (a.id && !s.people.some((p) => p.id === a.id))
          throw new Error('This person no longer exists.');
        const person = { id: a.id ?? id('person'), name: a.name.trim(), role: a.role };
        if (a.role !== 'owner' && !s.people.some((p) => p.id !== person.id && p.role === 'owner'))
          throw new Error('Keep at least one owner in the team.');
        s.people = [...s.people.filter((p) => p.id !== person.id), person];
        break;
      }
      case 'deletePerson':
        if (s.context.role !== 'owner') throw new Error('Only the owner can manage the team.');
        if (!s.people.some((p) => p.id !== a.id && p.role === 'owner'))
          throw new Error('Keep at least one owner in the team.');
        s.people = s.people.filter((p) => p.id !== a.id);
        break;
    }
    if (s.site.survey || s.deviceSimulation.hub || s.deviceSimulation.nodes.length)
      s.snapshot = snapshotForDeviceSimulation(s.snapshot, s.deviceSimulation, layoutForState(s));
  }
}
