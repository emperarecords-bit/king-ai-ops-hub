import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, appSql, asTenant, rlsAvailable } from '@tests/support/db';
import { keyBelongsToTenant, tenantObjectKey } from '@/domain/documents/object-store';

/**
 * O-23 acceptance Test 4 — cross-workspace storage isolation, proven at BOTH
 * layers: (a) PostgreSQL RLS as the app_server role, and (b) the object-key
 * authorization scheme. Workspace A can neither see nor act on Workspace B's
 * documents/jobs, and a Workspace B object key is not dereferenceable from A.
 */

const available = await rlsAvailable('document-cloud-isolation.test');

const ids = {
  userA: randomUUID(),
  userB: randomUUID(),
  orgA: randomUUID(),
  orgB: randomUUID(),
  projA: randomUUID(),
  projB: randomUUID(),
  docA: randomUUID(),
  docB: randomUUID(),
};

let admin: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  app = appSql();
  await admin`insert into profiles (id, email, display_name) values
    (${ids.userA}, ${`da-${ids.userA.slice(0, 8)}@t.local`}, 'DA'),
    (${ids.userB}, ${`db-${ids.userB.slice(0, 8)}@t.local`}, 'DB')`;
  await admin`insert into organizations (id, name, slug) values
    (${ids.orgA}, 'DOrg A', ${`do23a-${ids.orgA.slice(0, 8)}`}),
    (${ids.orgB}, 'DOrg B', ${`do23b-${ids.orgB.slice(0, 8)}`})`;
  await admin`insert into memberships (org_id, user_id, role) values
    (${ids.orgA}, ${ids.userA}, 'owner'), (${ids.orgB}, ${ids.userB}, 'owner')`;
  await admin`insert into projects (id, org_id, key, name) values
    (${ids.projA}, ${ids.orgA}, ${`zz-fixture-da-${ids.projA.slice(0, 8)}`}, 'DA'),
    (${ids.projB}, ${ids.orgB}, ${`zz-fixture-db-${ids.projB.slice(0, 8)}`}, 'DB')`;
  await admin`insert into project_members (org_id, project_id, user_id, role) values
    (${ids.orgA}, ${ids.projA}, ${ids.userA}, 'admin'),
    (${ids.orgB}, ${ids.projB}, ${ids.userB}, 'admin')`;
  const keyB = tenantObjectKey({ orgId: ids.orgB, projectId: ids.projB, sourceId: 'secret.md', versionHash: 'h' });
  await admin`insert into documents (id, org_id, project_id, source, source_id, relative_path, kind, sha256, size_bytes, object_key, status)
    values
    (${ids.docA}, ${ids.orgA}, ${ids.projA}, 'cloud_upload', 'a.md', 'a.md', 'markdown', 'ha', 10, ${tenantObjectKey({ orgId: ids.orgA, projectId: ids.projA, sourceId: 'a.md', versionHash: 'h' })}, 'active'),
    (${ids.docB}, ${ids.orgB}, ${ids.projB}, 'cloud_upload', 'secret.md', 'secret.md', 'markdown', 'hb', 10, ${keyB}, 'active')`;
  await admin`insert into document_jobs (org_id, project_id, document_id, status) values
    (${ids.orgB}, ${ids.projB}, ${ids.docB}, 'done')`;
  await app`select 1`;
});

afterAll(async () => {
  if (admin && available) {
    for (const org of [ids.orgA, ids.orgB]) {
      await admin`delete from document_jobs where org_id = ${org}`;
      await admin`delete from documents where org_id = ${org}`;
      await admin`delete from project_members where org_id = ${org}`;
      await admin`delete from projects where org_id = ${org}`;
      await admin`delete from memberships where org_id = ${org}`;
      await admin`delete from organizations where id = ${org}`;
    }
    await admin`delete from profiles where id in (${ids.userA}, ${ids.userB})`;
  }
  await admin?.end();
  await app?.end();
});

describe.skipIf(!available)('O-23 Test 4 — cross-workspace storage isolation', () => {
  it('RLS: Workspace A context cannot read Workspace B documents or jobs (filterless)', async () => {
    const seen = await asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.projA }, async (tx) => ({
      docs: await tx`select relative_path, object_key from documents`,
      jobs: await tx`select id from document_jobs`,
    }));
    expect(seen.docs.map((d) => d.relative_path)).toEqual(['a.md']); // only A's
    expect(seen.docs.some((d) => String(d.object_key).includes(ids.projB))).toBe(false);
    expect(seen.jobs.length).toBe(0); // B's job invisible
  });

  it('RLS: inserting a document into Workspace B from A context is refused (WITH CHECK)', async () => {
    await expect(
      asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.projA }, (tx) =>
        tx`insert into documents (org_id, project_id, source, source_id, relative_path, kind, sha256, size_bytes, status)
           values (${ids.orgB}, ${ids.projB}, 'cloud_upload', 'x.md', 'x.md', 'markdown', 'h', 1, 'active')`,
      ),
    ).rejects.toThrow();
  });

  it('RLS: updating/archiving a Workspace B document from A context affects zero rows', async () => {
    // Even the raw UPDATE (no app-layer filter) touches nothing — B's row is invisible.
    const res = await asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.projA }, (tx) =>
      tx`update documents set status = 'archived' where id = ${ids.docB}`,
    );
    expect(res.count).toBe(0);
    const stillActive = await admin`select status from documents where id = ${ids.docB}`;
    expect(stillActive[0]!.status).toBe('active');
  });

  it('object-key auth: a Workspace B key is not dereferenceable from Workspace A', () => {
    const keyB = tenantObjectKey({ orgId: ids.orgB, projectId: ids.projB, sourceId: 'secret.md', versionHash: 'h' });
    // Keys are tenant-partitioned by org + project prefix.
    expect(keyB.startsWith(`org/${ids.orgB}/project/${ids.projB}/`)).toBe(true);
    expect(keyBelongsToTenant(keyB, { orgId: ids.orgA, projectId: ids.projA })).toBe(false);
    expect(keyBelongsToTenant(keyB, { orgId: ids.orgB, projectId: ids.projB })).toBe(true);
    // A forged same-suffix key under A's prefix cannot point at B's object.
    const forged = `org/${ids.orgA}/project/${ids.projA}/doc/secret.md/h`;
    expect(keyBelongsToTenant(forged, { orgId: ids.orgA, projectId: ids.projA })).toBe(true);
    expect(forged).not.toBe(keyB);
  });
});
