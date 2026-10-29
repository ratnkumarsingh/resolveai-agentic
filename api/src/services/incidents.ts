import type { Incident } from "@resolveai/shared";
import { all, type Db, get } from "../db/index.js";

const COLUMNS = `id, key, title, service_name, severity, status, environment, started_at, detected_at, resolved_at, description, impact_summary`;

export interface IncidentFilters {
  status?: string;
  severity?: string;
  service?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export function listIncidents(db: Db, f: IncidentFilters): { items: Incident[]; total: number; page: number; page_size: number } {
  const where: string[] = [];
  const params: string[] = [];
  if (f.status) (where.push("status = ?"), params.push(f.status));
  if (f.severity) (where.push("severity = ?"), params.push(f.severity));
  if (f.service) (where.push("service_name = ?"), params.push(f.service));
  if (f.q) {
    where.push("(key LIKE ? OR title LIKE ? OR service_name LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM incidents ${clause}`, ...params)?.n ?? 0;
  // Active incidents first, then most severe, then newest.
  const items = all<Incident>(db,
    `SELECT ${COLUMNS} FROM incidents ${clause}
      ORDER BY CASE status WHEN 'resolved' THEN 1 ELSE 0 END, severity, started_at DESC
      LIMIT ? OFFSET ?`,
    ...params, f.pageSize, (f.page - 1) * f.pageSize,
  );
  return { items, total, page: f.page, page_size: f.pageSize };
}

/** Looks an incident up by UUID or by human key such as "INC-1042". */
export function findIncident(db: Db, idOrKey: string): Incident | undefined {
  return get<Incident>(db, `SELECT ${COLUMNS} FROM incidents WHERE id = ? OR key = ?`, idOrKey, idOrKey);
}

export function listServices(db: Db): string[] {
  return all<{ s: string }>(db, "SELECT DISTINCT service_name AS s FROM incidents ORDER BY s").map((r) => r.s);
}
