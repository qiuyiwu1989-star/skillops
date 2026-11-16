const CENTER = 'http://127.0.0.1:5050/api/inside/skills';
const samples = {
  storytelling: { kind: 'skill', id: 'b20a02ec-34b0-4258-ac6e-d2899e77b78a', version: '1.0.1', name: '用户价值叙事' },
  'product-management': { kind: 'plugin', id: 'aef5e4b6f4841c498eaa761b253a6f44daf19de42416f633c995ce07c9dea5d1', version: '1.2.0' },
};
const normalizeName = value => String(value || '').normalize('NFKC').trim().toLowerCase();
const normalizeBody = value => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
const isHash = value => /^[a-f0-9]{64}$/.test(value);

async function centerResponse(path, archive = false) {
  const token = process.env.PERSONAL_RELEASES_READ_TOKEN;
  if (!token) throw new Error('personal center unavailable');
  const response = await fetch(CENTER + path, {
    headers: { Authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404 || (archive && response.status === 409)) return null;
  if (!response.ok) throw new Error('personal center unavailable');
  return response;
}

async function centerRead(path) {
  const response = await centerResponse(path);
  return response && response.json();
}

export async function readPersonalLibrary(legacySkills) {
  const [skills, plugins, catalog] = await Promise.all([
    centerRead(''), centerRead('/plugins'), centerRead('/plugins/catalog'),
  ]);
  const published = new Set(catalog.skills.filter(item => item.published)
    .map(item => item.plugin_id + ':' + item.version + ':' + item.package_hash));
  const packages = new Map(catalog.skills.map(item => [
    item.plugin_id + ':' + item.version, item.package_hash,
  ]));
  const byName = new Map();
  const byId = new Map(legacySkills.map(item => [item.id, item]));
  for (const item of legacySkills) {
    const key = normalizeName(item.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }
  const rows = await Promise.all(skills.skills.map(async skill => {
    const release = skill.latest_release;
    const upstream = release?.upstream;
    const source = upstream?.service === 'SkillOps CN' ? byId.get(upstream.skill_id) : null;
    const names = byName.get(normalizeName(skill.name)) || [];
    const comparison = { links: [], candidates: [] };
    if ((source || names.length) && release) {
      const detail = await centerRead('/' + skill.id);
      const exact = detail?.releases?.find(item => item.id === release.id && item.hash === release.hash);
      if (!exact) throw new Error('personal catalog changed during reconciliation');
      const body = normalizeBody(exact.files?.['SKILL.md']);
      for (const old of new Map([...names, ...(source ? [source] : [])].map(item => [item.id, item])).values()) {
        const sameBody = Boolean(body && body === normalizeBody(old.content));
        const oldItem = { id: old.id, name: old.name, version: old.revision };
        if (sameBody && source?.id === old.id && upstream.version_id === old.versionId) {
          comparison.links.push(oldItem);
        } else {
          comparison.candidates.push({ ...oldItem, reason: sameBody ? '来源待核对' : '正文不同' });
        }
      }
    }
    return {
      kind: 'skill', id: skill.id, name: skill.name, description: skill.description,
      version: release?.version, packageHash: release?.hash, releaseId: release?.id,
      state: skill.status === 'archived' ? 'archived' : release ? 'published' : 'draft',
      ...comparison,
    };
  }));
  return {
    skills: rows,
    plugins: plugins.plugins.map(plugin => {
      const key = plugin.id + ':' + plugin.latest_version;
      const packageHash = packages.get(key);
      return {
        kind: 'plugin', id: plugin.id, name: plugin.name, description: plugin.description,
        version: plugin.latest_version, versions: plugin.versions, packageHash,
        state: published.has(key + ':' + packageHash) ? 'published' : 'registered',
        links: [],
        candidates: (byName.get(normalizeName(plugin.name)) || []).map(old => ({
          id: old.id, name: old.name, version: old.revision, reason: '同名插件与独立技能',
        })),
      };
    }),
  };
}

export async function readPersonalRelease(kind, id, version, name, { includeAssessments = true } = {}) {
  if (!id) {
    const sample = samples[kind];
    if (!sample) return null;
    return readPersonalRelease(sample.kind, sample.id, sample.version, sample.name);
  }
  const url = new URL('/admin/skills.html', 'https://qiuyiwu.com');
  url.searchParams.set(kind, id);

  if (kind === 'skill') {
    const path = '/' + id;
    const skill = await centerRead(path);
    if (!skill || skill.id !== id) return null;
    const selected = version ? skill.releases?.find(item => item.version === version) : skill.releases?.at(-1);
    if (version && !selected) return null;
    if (selected && (!selected.id || !isHash(selected.hash) || !selected.files)) throw new Error('invalid release');
    const files = selected ? selected.files : skill.files || {};
    const [reviews, evaluations, sms] = includeAssessments ? await Promise.all([
      centerRead(path + '/reviews'), centerRead(path + '/evaluations'), centerRead(path + '/sms-assessments'),
    ]) : [];
    if (selected) url.searchParams.set('version', selected.version);
    if (selected?.trial) url.hash = 'trial';
    return {
      kind, id, name: name || skill.name, version: selected?.version, url: url.href,
      state: skill.status === 'archived' ? 'archived' : selected ? 'published' : 'draft',
      releaseId: selected?.id, packageHash: selected?.hash || skill.hash,
      versions: (skill.releases || []).map(item => ({
        version: item.version, releaseId: item.id, packageHash: item.hash, at: item.created_at,
      })),
      files: Object.keys(files), attachments: files, content: files['SKILL.md'], trial: selected?.trial,
      reviews: (reviews?.reviews || []).filter(item => item.hash === (selected?.hash || skill.hash)),
      evaluations: (evaluations?.evaluations || []).filter(item =>
        selected ? item.release_id === selected.id : item.current && item.release_id === 'draft'),
      sms: (sms?.assessments || []).filter(item => item.version === selected?.version && item.hash === selected?.hash),
    };
  }

  const path = '/plugins/' + id;
  const [detail, publications, reviews] = await Promise.all([
    centerRead(path + (version ? '?version=' + encodeURIComponent(version) : '')),
    centerRead(path + '/publications'), includeAssessments ? centerRead(path + '/reviews') : null,
  ]);
  const { plugin, release } = detail || {};
  if (!plugin || plugin.id !== id || !release) return null;
  if (!isHash(release.hash) || (version && release.version !== version)) throw new Error('invalid plugin version');
  const published = (publications?.publications || []).some(item =>
    item.version === release.version && item.hash === release.hash && item.scope === 'private-catalog');
  return {
    kind, id, name: name || plugin.name, version: release.version, packageHash: release.hash,
    archiveHash: release.archive_sha256, manifest: release.manifest, state: published ? 'published' : 'registered',
    files: release.files.map(file => file.path), members: release.skills, published,
    versions: plugin.releases.map(item => ({ version: item.version, packageHash: item.hash, at: item.created_at })),
    reviews: (reviews?.reviews || []).filter(item => item.version === release.version && item.hash === release.hash),
  };
}

export async function readPersonalPluginFile(id, version, path) {
  return centerRead('/plugins/' + id + '/file?' + new URLSearchParams({ version, path }));
}

export async function readPersonalPluginArchive(id, version, hash) {
  return centerResponse('/plugins/' + id + '/download?' + new URLSearchParams({ version, hash }), true);
}
