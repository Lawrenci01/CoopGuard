import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInstallationPlan,
  commissioningChecks,
  houseCapabilities,
  installationChecks,
  trialChecks,
  validSiteSurvey,
} from '../src/domain/siteWorkflow';
import { LocalFarmRepository } from '../src/services/localFarmRepository';
import { completeSiteSurvey, pairPlannedVirtualDevices } from './siteTestFixture';
import {
  farmQr,
  pairingQr,
  parseFarmQr,
  snapshotForDeviceSimulation,
} from '../src/domain/deviceSimulation';
import { createDemoSnapshot } from '../src/data/fixtures';

test('a verified open house can become a control candidate but never activates from the survey alone', async () => {
  const survey = completeSiteSurvey();
  assert.equal(validSiteSurvey(survey), true);
  assert.equal(buildInstallationPlan(survey).recommendedMode, 'full_candidate');
  let encoded: string | null = null;
  const repo = new LocalFarmRepository({
    getItem: async () => encoded,
    setItem: async (_key, value) => {
      encoded = value;
    },
  });
  await repo.load();
  await repo.dispatch({ type: 'context', patch: { role: 'technician', connection: 'local' } });
  let state = await repo.dispatch({ type: 'saveSiteSurvey', value: survey });
  assert.equal(state.site.status, 'review_required');
  assert.equal(state.context.controlMode, 'monitor');
  await assert.rejects(repo.dispatch({ type: 'activateSite', mode: 'full' }), /monitoring trial/);

  state = await repo.dispatch({ type: 'approveSitePlan' });
  assert.equal(state.site.status, 'approved_install');
  await repo.dispatch({ type: 'startInstallation' });
  await assert.rejects(
    repo.dispatch({
      type: 'siteChecklist',
      stage: 'installation',
      key: 'wiringCompleted',
      value: 'na',
    }),
    /cannot be N\/A/,
  );
  for (const [key] of installationChecks)
    await repo.dispatch({ type: 'siteChecklist', stage: 'installation', key, value: 'passed' });
  await assert.rejects(
    repo.dispatch({ type: 'beginCommissioning' }),
    /Pair the planned hub and sensor nodes/,
  );
  await pairPlannedVirtualDevices(repo);
  await repo.dispatch({ type: 'beginCommissioning' });
  for (const [key] of commissioningChecks)
    await repo.dispatch({ type: 'siteChecklist', stage: 'commissioning', key, value: 'passed' });
  await repo.dispatch({ type: 'startMonitoringTrial' });
  for (const [key] of trialChecks)
    await repo.dispatch({ type: 'siteChecklist', stage: 'trial', key, value: 'passed' });
  state = await repo.dispatch({ type: 'activateSite', mode: 'full' });
  assert.equal(state.site.status, 'normal_control');
  assert.equal(state.context.controlMode, 'full');
  assert.equal(state.snapshot.sensors.length, 3);
  assert.deepEqual(
    state.snapshot.sensors.map((sensor) => sensor.section),
    ['A', 'B', 'C'],
  );

  const removedNodeId = state.deviceSimulation.nodes[0]!.id;
  state = await repo.dispatch({ type: 'removeVirtualDevice', id: removedNodeId });
  assert.equal(state.deviceSimulation.nodes.length, 2);
  assert.equal(state.snapshot.sensors.length, 2);

  state = await repo.dispatch({
    type: 'createVirtualNode',
    farmCode: 'CG-PH-TEST01',
    section: 'A',
  });
  const replacement = state.deviceSimulation.nodes.at(-1)!;
  state = await repo.dispatch({
    type: 'pairVirtualDevice',
    qr: pairingQr({
      version: 1,
      kind: 'node',
      farmCode: replacement.farmCode,
      deviceId: replacement.id,
      pairingCode: replacement.pairingCode,
    }),
  });
  assert.equal(state.deviceSimulation.nodes.length, 3);
  assert.equal(state.snapshot.sensors.length, 3);
  assert.equal(state.deviceSimulation.nodes.at(-1)!.status, 'reporting');
});

test('the simulated farm snapshot contains one record per installed node', () => {
  const snapshot = snapshotForDeviceSimulation(createDemoSnapshot(100), {
    enabled: true,
    hub: null,
    history: [],
    nodes: (['A', 'B', 'C'] as const).map((section, index) => ({
      id: `NODE-TEST${String(index).padStart(2, '0')}`,
      farmCode: 'CG-PH-TEST01',
      pairingCode: `PAIRINGCODE${String(index).padStart(2, '0')}`,
      section,
      status: 'reporting',
      createdAt: index,
    })),
  });

  assert.deepEqual(
    snapshot.sensors.map(({ id, section }) => [id, section]),
    [
      ['NODE-TEST00', 'A'],
      ['NODE-TEST01', 'B'],
      ['NODE-TEST02', 'C'],
    ],
  );
  assert.equal(snapshot.sensors.length, 3);
  assert.ok(snapshot.sensors.every((sensor) => sensor.online));
  assert.ok(
    snapshot.alerts.every((alert) =>
      snapshot.sensors.some((sensor) => sensor.id === alert.sensorId),
    ),
  );
});

test('virtual firmware updates save a simulated version and device history', async () => {
  let encoded: string | null = null;
  const repo = new LocalFarmRepository({
    getItem: async () => encoded,
    setItem: async (_key, value) => {
      encoded = value;
    },
  });
  await repo.load();
  await repo.dispatch({ type: 'context', patch: { role: 'technician', connection: 'local' } });
  await repo.dispatch({ type: 'saveSiteSurvey', value: completeSiteSurvey() });
  await repo.dispatch({ type: 'approveSitePlan' });
  await pairPlannedVirtualDevices(repo);
  const before = JSON.parse(encoded!) as { deviceSimulation: { nodes: { id: string }[] } };
  const nodeId = before.deviceSimulation.nodes[0]!.id;
  const state = await repo.dispatch({ type: 'updateVirtualFirmware', id: nodeId });

  assert.equal(state.deviceSimulation.nodes[0]!.firmwareVersion, '0.1.1-sim');
  assert.equal(state.deviceSimulation.history[0]!.deviceId, nodeId);
  assert.equal(state.deviceSimulation.history[0]!.action, 'firmware_updated');
  assert.match(state.deviceSimulation.history[0]!.details, /0\.1\.1-sim/);
});

test('virtual device QR codes are farm-bound and a paired hub is required before nodes', async () => {
  assert.equal(parseFarmQr(farmQr('CG-PH-TEST01')), 'CG-PH-TEST01');
  assert.throws(() => parseFarmQr('https://example.com/farm/CG-PH-TEST01'), /Farm QR/);
  let encoded: string | null = null;
  const repo = new LocalFarmRepository({
    getItem: async () => encoded,
    setItem: async (_key, value) => {
      encoded = value;
    },
  });
  await repo.load();
  await repo.dispatch({ type: 'context', patch: { role: 'technician', connection: 'local' } });
  await repo.dispatch({ type: 'saveSiteSurvey', value: completeSiteSurvey() });
  await assert.rejects(
    repo.dispatch({
      type: 'createVirtualNode',
      farmCode: 'CG-PH-TEST01',
      section: 'A',
    }),
    /Pair the virtual hub/,
  );
  const state = await repo.dispatch({ type: 'createVirtualHub', farmCode: 'CG-PH-TEST01' });
  const hub = state.deviceSimulation.hub!;
  await assert.rejects(
    repo.dispatch({
      type: 'pairVirtualDevice',
      qr: pairingQr({
        version: 1,
        kind: 'hub',
        farmCode: 'CG-PH-WRONG1',
        deviceId: hub.id,
        pairingCode: hub.pairingCode,
      }),
    }),
    /does not belong to the selected farm/,
  );
});

test('controller presence and missing electrical approval produce a monitor-only plan', () => {
  const survey = completeSiteSurvey();
  survey.controller.status = 'present';
  survey.safety.electricalAssessment = 'required';
  const plan = buildInstallationPlan(survey);
  assert.equal(plan.recommendedMode, 'monitor');
  assert.ok(plan.controlRestrictions.some((item) => item.includes('controller')));
  assert.ok(plan.controlRestrictions.some((item) => item.includes('Electrical')));
});

test('survey choices produce a house-specific app and hardware function profile', () => {
  const survey = completeSiteSurvey();
  survey.sensors.ammonia = true;
  survey.sensors.microphone = true;
  survey.ai.audioConsent = 'no';
  let capabilities = houseCapabilities(survey);
  assert.ok(capabilities.app.some((item) => item.includes('Ammonia')));
  assert.ok(capabilities.app.some((item) => item.includes('Fans (4)')));
  assert.ok(!capabilities.app.some((item) => item.includes('Sound anomaly')));
  assert.match(capabilities.control, /Automatic control candidate for Fans/);

  survey.ai.audioConsent = 'yes';
  survey.controller.status = 'present';
  capabilities = houseCapabilities(survey);
  assert.ok(capabilities.app.some((item) => item.includes('Sound anomaly')));
  assert.match(capabilities.control, /unavailable.*controller/i);
});
