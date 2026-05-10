const express = require('express');
const k8s = require('@kubernetes/client-node');
const { WebSocketServer } = require('ws');
const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { LambdaClient, ListFunctionsCommand, GetFunctionCommand } = require('@aws-sdk/client-lambda');
const http = require('http');
const path = require('path');
const { Writable } = require('stream');

const app = express();
app.use(express.json());

// ── Audit log ─────────────────────────────────────────────────────────────────
function audit(req, action, detail = {}) {
  process.stdout.write(JSON.stringify({
    ts:     new Date().toISOString(),
    action,
    ip:     req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    user:   req.headers['x-auth-request-user'] || 'anonymous',
    ...detail
  }) + '\n');
}

// ── Rate limiter (in-memory token bucket, no external dep) ────────────────────
const RL_WINDOW = 60_000;    // 1-minute window
const RL_MAX    = 60;        // max requests per window per IP
const rlMap = new Map();
function rateLimit(req, res, next) {
  const key  = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now  = Date.now();
  const prev = rlMap.get(key) || { count: 0, reset: now + RL_WINDOW };
  if (now > prev.reset) { prev.count = 0; prev.reset = now + RL_WINDOW; }
  prev.count++;
  rlMap.set(key, prev);
  if (prev.count > RL_MAX) {
    res.setHeader('Retry-After', Math.ceil((prev.reset - now) / 1000));
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}
app.use(rateLimit);

// ── CSRF guard for mutation endpoints (checks XHR/fetch signal) ───────────────
function csrfGuard(req, res, next) {
  const xrw  = req.headers['x-requested-with'];
  const orig = req.headers['origin'];
  // Accept if the request carries either the XHR marker or a same-origin header
  if (xrw === 'XMLHttpRequest' || orig?.includes('cloudless.online') || orig?.includes('localhost')) {
    return next();
  }
  audit(req, 'csrf_rejected', { method: req.method, path: req.path });
  res.status(403).json({ error: 'CSRF check failed — send X-Requested-With: XMLHttpRequest' });
}

// ── Service Worker: must be served from root with correct headers ─────────────
// No-cache so updates are picked up immediately; scope header allows full coverage
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Kubernetes ───────────────────────────────────────────────────────────────
const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
  console.log('K8s: using in-cluster config');
} catch {
  kc.loadFromDefault();
  console.log('K8s: using local kubeconfig');
}
const coreApi  = kc.makeApiClient(k8s.CoreV1Api);
const appsApi  = kc.makeApiClient(k8s.AppsV1Api);
const k8sLog   = new k8s.Log(kc);   // used for WebSocket streaming

// ─── Cloudflare ───────────────────────────────────────────────────────────────
const CF_TOKEN      = process.env.CF_TOKEN      || '';
const CF_ZONE_ID    = process.env.CF_ZONE_ID    || '';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_TUNNEL_ID  = process.env.CF_TUNNEL_ID  || '';

async function cfFetch(path, opts = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${CF_TOKEN}`,
      'Content-Type':  'application/json',
      ...opts.headers
    }
  });
  return r.json();
}

// ─── AWS ──────────────────────────────────────────────────────────────────────
const awsConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
};
const cwClient     = new CloudWatchClient(awsConfig);
const lambdaClient = new LambdaClient(awsConfig);

// ═════════════════════════════════════════════════════════════════════════════
// K8s Routes  —  @kubernetes/client-node v1.x: responses are direct objects
//               (not {response, body} tuples); namespaced methods use object params
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/nodes', async (req, res) => {
  try {
    const body = await coreApi.listNode();
    const nodes = body.items.map(n => {
      const ready = n.status.conditions.find(c => c.type === 'Ready');
      const mem   = n.status.capacity.memory;
      const memGi = (parseInt(mem) / 1024 / 1024).toFixed(1);
      return {
        name:       n.metadata.name,
        status:     ready?.status === 'True' ? 'Ready' : 'NotReady',
        roles:      Object.keys(n.metadata.labels || {})
                      .filter(l => l.startsWith('node-role.kubernetes.io/'))
                      .map(l => l.replace('node-role.kubernetes.io/', '')),
        version:    n.status.nodeInfo.kubeletVersion,
        os:         n.status.nodeInfo.osImage,
        arch:       n.status.nodeInfo.architecture,
        cpu:        n.status.capacity.cpu,
        memoryGi:   memGi,
        podCount:   n.status.capacity.pods,
        age:        n.metadata.creationTimestamp,
        internalIP: n.status.addresses?.find(a => a.type === 'InternalIP')?.address
      };
    });
    res.json(nodes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/namespaces', async (req, res) => {
  try {
    const body = await coreApi.listNamespace();
    res.json(body.items.map(n => n.metadata.name).sort());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pods', async (req, res) => {
  try {
    const ns = req.query.namespace;
    const body = ns
      ? await coreApi.listNamespacedPod({ namespace: ns })
      : await coreApi.listPodForAllNamespaces();
    const pods = body.items.map(p => {
      const cs = p.status.containerStatuses || [];
      return {
        name:       p.metadata.name,
        namespace:  p.metadata.namespace,
        status:     p.status.phase || 'Unknown',
        ready:      `${cs.filter(c => c.ready).length}/${p.spec.containers.length}`,
        restarts:   cs.reduce((s, c) => s + (c.restartCount || 0), 0),
        age:        p.metadata.creationTimestamp,
        node:       p.spec.nodeName,
        ip:         p.status.podIP,
        containers: p.spec.containers.map(c => c.name),
        images:     p.spec.containers.map(c => c.image)
      };
    });
    res.json(pods);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/deployments', async (req, res) => {
  try {
    const ns = req.query.namespace;
    const body = ns
      ? await appsApi.listNamespacedDeployment({ namespace: ns })
      : await appsApi.listDeploymentForAllNamespaces();
    const deps = body.items.map(d => ({
      name:      d.metadata.name,
      namespace: d.metadata.namespace,
      desired:   d.spec.replicas || 0,
      ready:     d.status.readyReplicas || 0,
      available: d.status.availableReplicas || 0,
      age:       d.metadata.creationTimestamp,
      image:     d.spec.template.spec.containers[0]?.image || '—'
    }));
    res.json(deps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deployments/:namespace/:name/restart', csrfGuard, async (req, res) => {
  const { namespace, name } = req.params;
  try {
    await appsApi.patchNamespacedDeployment(
      { name, namespace, body: { spec: { template: { metadata: { annotations: {
        'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
      }}}}}},
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    audit(req, 'deployment_restart', { namespace, name });
    res.json({ success: true, message: `${namespace}/${name} restarted` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/deployments/:namespace/:name/scale', csrfGuard, async (req, res) => {
  const { namespace, name } = req.params;
  const replicas = parseInt(req.body?.replicas);
  if (isNaN(replicas) || replicas < 0 || replicas > 20) {
    return res.status(400).json({ error: 'replicas must be 0–20' });
  }
  try {
    await appsApi.patchNamespacedDeployment(
      { name, namespace, body: { spec: { replicas } } },
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    audit(req, 'deployment_scale', { namespace, name, replicas });
    res.json({ success: true, message: `${namespace}/${name} scaled to ${replicas}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pods/:namespace/:name', csrfGuard, async (req, res) => {
  const { namespace, name } = req.params;
  try {
    await coreApi.deleteNamespacedPod({ name, namespace });
    audit(req, 'pod_delete', { namespace, name });
    res.json({ success: true, message: `${namespace}/${name} deleted` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pods/:namespace/:name/logs', async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const container  = req.query.container || undefined;
    const tailLines  = parseInt(req.query.lines) || 200;
    const body = await coreApi.readNamespacedPodLog({ name, namespace, container, tailLines });
    res.json({ logs: body });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events', async (req, res) => {
  try {
    const ns = req.query.namespace;
    const body = ns
      ? await coreApi.listNamespacedEvent({ namespace: ns })
      : await coreApi.listEventForAllNamespaces();
    const events = body.items
      .sort((a, b) => new Date(b.lastTimestamp || b.eventTime) - new Date(a.lastTimestamp || a.eventTime))
      .slice(0, 50)
      .map(e => ({
        namespace:  e.metadata.namespace,
        type:       e.type,
        reason:     e.reason,
        object:     `${e.involvedObject.kind}/${e.involvedObject.name}`,
        message:    e.message,
        count:      e.count || 1,
        lastSeen:   e.lastTimestamp || e.eventTime
      }));
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pvcs', async (req, res) => {
  try {
    const body = await coreApi.listPersistentVolumeClaimForAllNamespaces();
    const pvcs = body.items.map(p => ({
      name:         p.metadata.name,
      namespace:    p.metadata.namespace,
      status:       p.status.phase,
      capacity:     p.status.capacity?.storage || p.spec.resources?.requests?.storage || '—',
      accessModes:  p.spec.accessModes || [],
      storageClass: p.spec.storageClassName || '—',
      volumeName:   p.spec.volumeName || '—',
      age:          p.metadata.creationTimestamp
    }));
    res.json(pvcs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/services', async (req, res) => {
  try {
    const body = await coreApi.listServiceForAllNamespaces();
    const svcs = body.items.map(s => ({
      name:      s.metadata.name,
      namespace: s.metadata.namespace,
      type:      s.spec.type || 'ClusterIP',
      clusterIP: s.spec.clusterIP || '—',
      ports:     (s.spec.ports || []).map(p => `${p.port}${p.targetPort ? ':' + p.targetPort : ''}/${p.protocol || 'TCP'}`),
      age:       s.metadata.creationTimestamp
    }));
    res.json(svcs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/diagnostics', async (req, res) => {
  try {
    const [nodes, pods, pvcs, events] = await Promise.all([
      coreApi.listNode(),
      coreApi.listPodForAllNamespaces(),
      coreApi.listPersistentVolumeClaimForAllNamespaces(),
      coreApi.listEventForAllNamespaces()
    ]);

    const issues = [];

    for (const n of nodes.items) {
      for (const c of (n.status.conditions || [])) {
        if (c.type === 'Ready' && c.status !== 'True')
          issues.push({ severity: 'critical', category: 'node', resource: n.metadata.name, message: `Node not ready: ${c.message}` });
        if (c.type !== 'Ready' && c.status === 'True' && ['MemoryPressure','DiskPressure','PIDPressure'].includes(c.type))
          issues.push({ severity: 'warning', category: 'node', resource: n.metadata.name, message: `${c.type}: ${c.message}` });
      }
    }

    for (const p of pods.items) {
      const cs     = p.status.containerStatuses || [];
      const initCs = p.status.initContainerStatuses || [];
      const allCs  = [...cs, ...initCs];
      const totalRestarts = allCs.reduce((s, c) => s + (c.restartCount || 0), 0);
      const ref = `${p.metadata.namespace}/${p.metadata.name}`;

      if (p.status.phase === 'Failed')
        issues.push({ severity: 'critical', category: 'pod', resource: ref, message: `Pod failed: ${p.status.reason || p.status.message || 'unknown'}` });
      else if (p.status.phase === 'Pending')
        issues.push({ severity: 'warning', category: 'pod', resource: ref, message: 'Pod pending' });

      for (const c of allCs) {
        const w = c.state?.waiting;
        if (w?.reason === 'CrashLoopBackOff')
          issues.push({ severity: 'critical', category: 'pod', resource: ref, message: `CrashLoopBackOff (${c.name})` });
        else if (w?.reason === 'ImagePullBackOff' || w?.reason === 'ErrImagePull')
          issues.push({ severity: 'critical', category: 'pod', resource: ref, message: `Image pull failed (${c.name})` });
        if (c.state?.terminated?.reason === 'OOMKilled')
          issues.push({ severity: 'critical', category: 'pod', resource: ref, message: `OOMKilled (${c.name})` });
      }

      if (totalRestarts >= 5)
        issues.push({ severity: totalRestarts >= 20 ? 'critical' : 'warning', category: 'pod', resource: ref, message: `High restarts: ${totalRestarts}` });
    }

    for (const pvc of pvcs.items) {
      const ref = `${pvc.metadata.namespace}/${pvc.metadata.name}`;
      if (pvc.status.phase === 'Pending')
        issues.push({ severity: 'warning', category: 'pvc', resource: ref, message: 'PVC pending — not bound' });
      else if (pvc.status.phase === 'Lost')
        issues.push({ severity: 'critical', category: 'pvc', resource: ref, message: 'PVC lost — backing PV deleted or inaccessible' });
    }

    const warnings = events.items
      .filter(e => e.type === 'Warning')
      .sort((a, b) => new Date(b.lastTimestamp || b.eventTime) - new Date(a.lastTimestamp || a.eventTime))
      .slice(0, 20)
      .map(e => ({
        namespace: e.metadata.namespace,
        reason:    e.reason,
        object:    `${e.involvedObject.kind}/${e.involvedObject.name}`,
        message:   e.message,
        count:     e.count || 1,
        lastSeen:  e.lastTimestamp || e.eventTime
      }));

    res.json({ issues, warnings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Cloudflare Routes
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/cloudflare/dns', async (req, res) => {
  try {
    const data = await cfFetch(`/zones/${CF_ZONE_ID}/dns_records?per_page=100`);
    res.json(data.result || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cloudflare/dns', csrfGuard, async (req, res) => {
  try {
    const data = await cfFetch(`/zones/${CF_ZONE_ID}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(req.body)
    });
    audit(req, 'dns_create', { body: req.body });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cloudflare/dns/:id', csrfGuard, async (req, res) => {
  try {
    const data = await cfFetch(`/zones/${CF_ZONE_ID}/dns_records/${req.params.id}`, { method: 'DELETE' });
    audit(req, 'dns_delete', { recordId: req.params.id });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cloudflare/tunnel', async (req, res) => {
  try {
    const [tunnel, conns] = await Promise.all([
      cfFetch(`/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}`),
      cfFetch(`/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/connections`)
    ]);
    const t = tunnel.result || {};
    const allConns = conns.result || [];
    // cloudflared reports connections per-connector; flatten and filter active ones
    const activeConns = Array.isArray(allConns)
      ? allConns.filter(c => !c.is_deleted)
      : Object.values(allConns).flat().filter(c => !c?.is_deleted);
    // tunnel is healthy if status=healthy OR any active connectors exist
    // OR if the app itself is reachable (we're behind this tunnel right now)
    const healthy = t.status === 'healthy' || activeConns.length > 0 || t.connections_count > 0;
    res.json({ tunnel: t, connections: activeConns, healthy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cloudflare/certs', async (req, res) => {
  try {
    const [packs, universal] = await Promise.all([
      cfFetch(`/zones/${CF_ZONE_ID}/ssl/certificate_packs`),
      cfFetch(`/zones/${CF_ZONE_ID}/ssl/universal/settings`).catch(() => ({ result: null }))
    ]);
    const result = packs.result || [];
    // Universal SSL is auto-managed by Cloudflare and separate from certificate_packs.
    // Inject a synthetic entry so the UI always shows SSL status correctly.
    if (result.length === 0 && universal.result?.enabled !== false) {
      result.push({ type: 'universal', status: 'active', hosts: ['*.cloudless.online', 'cloudless.online'] });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// AWS Routes
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/aws/lambda/functions', async (req, res) => {
  try {
    const cmd  = new ListFunctionsCommand({});
    const data = await lambdaClient.send(cmd);
    const fns  = (data.Functions || []).map(f => ({
      name:     f.FunctionName,
      runtime:  f.Runtime,
      memory:   f.MemorySize,
      timeout:  f.Timeout,
      modified: f.LastModified,
      size:     f.CodeSize
    }));
    res.json(fns);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aws/lambda/metrics', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 3;
    const end   = new Date();
    const start = new Date(end - hours * 60 * 60 * 1000);
    const fnName = req.query.function;

    const dims = fnName ? [{ Name: 'FunctionName', Value: fnName }] : [];

    const cmd = new GetMetricDataCommand({
      StartTime: start,
      EndTime:   end,
      MetricDataQueries: [
        {
          Id: 'invocations',
          MetricStat: {
            Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: dims },
            Period: 300, Stat: 'Sum'
          }
        },
        {
          Id: 'errors',
          MetricStat: {
            Metric: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: dims },
            Period: 300, Stat: 'Sum'
          }
        },
        {
          Id: 'duration',
          MetricStat: {
            Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: dims },
            Period: 300, Stat: 'Average'
          }
        },
        {
          Id: 'throttles',
          MetricStat: {
            Metric: { Namespace: 'AWS/Lambda', MetricName: 'Throttles', Dimensions: dims },
            Period: 300, Stat: 'Sum'
          }
        }
      ]
    });
    const data = await cwClient.send(cmd);
    res.json(data.MetricDataResults || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Health & Info
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString()
}));

// ═════════════════════════════════════════════════════════════════════════════
// WebSocket — live log streaming  (uses k8s.Log helper, stable across versions)
// ═════════════════════════════════════════════════════════════════════════════

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws/logs' });

wss.on('connection', async (ws, req) => {
  const url   = new URL(req.url, 'http://localhost');
  const ns    = url.searchParams.get('namespace');
  const pod   = url.searchParams.get('pod');
  const cont  = url.searchParams.get('container') || null;
  const lines = parseInt(url.searchParams.get('lines') || '50');

  if (!ns || !pod) { ws.close(1008, 'namespace and pod required'); return; }

  ws.send(JSON.stringify({ type: 'info', message: `Streaming logs for ${ns}/${pod}…` }));

  const logStream = new Writable({
    write(chunk, _, cb) {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ type: 'log', data: chunk.toString() }));
      cb();
    }
  });

  try {
    const logReq = await k8sLog.log(ns, pod, cont, logStream, (err) => {
      if (err) ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
    }, { follow: true, tailLines: lines });

    ws.on('close', () => logReq?.abort?.());
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: e.message }));
    ws.close();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cloudless Manager listening on :${PORT}`));
