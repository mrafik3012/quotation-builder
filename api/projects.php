<?php
declare(strict_types=1);
// Projects: created from accepted quotes. Billing milestones, receipts, variation orders, site log, tax invoices.

function pdate($v): ?string
{
    return preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$v) ? (string)$v : null;
}

function project_total(array $p, float $approvedVar): float
{
    return round((float)$p['base_value'] + $approvedVar * (1 + (float)$p['tax_rate'] / 100), 2);
}

function project_detail(int $id): array
{
    $p = q('SELECT * FROM projects WHERE id = ?', [$id])->fetch();
    if (!$p) fail('Project not found', 404);
    $ms = q('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort, id', [$id])->fetchAll();
    $rc = q('SELECT * FROM project_receipts WHERE project_id = ? ORDER BY received_on, id', [$id])->fetchAll();
    $vr = q('SELECT * FROM project_variations WHERE project_id = ? ORDER BY id', [$id])->fetchAll();
    $lg = q('SELECT * FROM project_log WHERE project_id = ? ORDER BY log_date DESC, id DESC LIMIT 100', [$id])->fetchAll();
    $paid = [];
    foreach ($rc as &$r) {
        $r['id'] = (int)$r['id']; $r['amount'] = (float)$r['amount']; $r['milestone_id'] = $r['milestone_id'] !== null ? (int)$r['milestone_id'] : null;
        if ($r['milestone_id']) $paid[$r['milestone_id']] = ($paid[$r['milestone_id']] ?? 0) + $r['amount'];
    }
    $billed = 0.0; $today = date('Y-m-d');
    foreach ($ms as &$m) {
        $m['id'] = (int)$m['id']; $m['amount'] = (float)$m['amount']; $m['percent'] = (float)$m['percent'];
        $m['paid'] = round($paid[$m['id']] ?? 0, 2);
        $m['state'] = $m['paid'] >= $m['amount'] - 0.01 && $m['amount'] > 0 ? 'paid' : ($m['paid'] > 0 ? 'part' : ($m['invoice_no'] ? 'invoiced' : 'pending'));
        $m['overdue'] = $m['state'] !== 'paid' && $m['due_date'] && $m['due_date'] < $today;
        $billed += $m['amount'];
    }
    $appr = 0.0;
    foreach ($vr as &$v) { $v['id'] = (int)$v['id']; $v['amount'] = (float)$v['amount']; if ($v['status'] === 'approved') $appr += $v['amount']; }
    $total = project_total($p, $appr);
    $received = round(array_sum(array_column($rc, 'amount')), 2);
    $p['id'] = (int)$p['id']; $p['client_id'] = $p['client_id'] !== null ? (int)$p['client_id'] : null; $p['base_value'] = (float)$p['base_value']; $p['tax_rate'] = (float)$p['tax_rate'];
    $quote = q('SELECT id,quote_no,rev,title,client_json,data,valid_until FROM quotes WHERE quote_no = ? AND is_latest = 1', [$p['quote_no']])->fetch();
    $qd = $quote ? (json_decode((string)$quote['data'], true) ?: []) : [];
    return ['project' => $p, 'milestones' => $ms, 'receipts' => $rc, 'variations' => $vr, 'log' => $lg,
        'totals' => ['contract' => $total, 'variations' => round($appr * (1 + (float)$p['tax_rate'] / 100), 2), 'billed' => round($billed, 2), 'received' => $received, 'outstanding' => round($total - $received, 2)],
        'quote' => $quote ? ['id' => (int)$quote['id'], 'quote_no' => $quote['quote_no'], 'client' => json_decode((string)$quote['client_json'], true) ?: new stdClass(), 'gst_mode' => $qd['gst_mode'] ?? '', 'hsn' => $qd['hsn'] ?? ''] : null];
}

function receivables_summary(): array
{
    $rows = q("SELECT p.id, p.base_value, p.tax_rate, p.status,
        (SELECT COALESCE(SUM(v.amount),0) FROM project_variations v WHERE v.project_id = p.id AND v.status = 'approved') AS var,
        (SELECT COALESCE(SUM(r.amount),0) FROM project_receipts r WHERE r.project_id = p.id) AS rec FROM projects p")->fetchAll();
    $contract = 0.0; $rec = 0.0; $active = 0;
    foreach ($rows as $r) { $contract += project_total($r, (float)$r['var']); $rec += (float)$r['rec']; if ($r['status'] === 'active') $active++; }
    $today = date('Y-m-d');
    $od = q("SELECT COUNT(*) AS n FROM project_milestones m WHERE m.due_date IS NOT NULL AND m.due_date < ? AND m.amount > COALESCE((SELECT SUM(r.amount) FROM project_receipts r WHERE r.milestone_id = m.id),0) + 0.01", [$today])->fetch();
    return ['projects' => count($rows), 'active' => $active, 'contract' => round($contract, 2), 'received' => round($rec, 2), 'outstanding' => round($contract - $rec, 2), 'overdue' => (int)$od['n']];
}

function next_invoice_no(string $date): string
{
    $prefix = (string)(get_setting('quote_prefix') ?: 'INF');
    $head = $prefix . '/INV/' . financial_year($date) . '/';
    $max = 0;
    foreach (q('SELECT invoice_no FROM project_milestones WHERE invoice_no LIKE ?', [$head . '%'])->fetchAll() as $r) $max = max($max, (int)substr($r['invoice_no'], strlen($head)));
    return $head . str_pad((string)($max + 1), 4, '0', STR_PAD_LEFT);
}

function projects_route(string $m, array $p, array $user): void
{
    $id = isset($p[0]) && ctype_digit($p[0]) ? (int)$p[0] : null;
    $sub = $p[1] ?? null;
    $sid = isset($p[2]) && ctype_digit($p[2]) ? (int)$p[2] : null;

    if ($id === null) {
        if ($m === 'GET') {
            $rows = q("SELECT p.*, (SELECT COALESCE(SUM(v.amount),0) FROM project_variations v WHERE v.project_id = p.id AND v.status = 'approved') AS var,
                (SELECT COALESCE(SUM(r.amount),0) FROM project_receipts r WHERE r.project_id = p.id) AS rec,
                (SELECT c.name FROM clients c WHERE c.id = p.client_id) AS client_name,
                (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = p.id AND m.due_date IS NOT NULL AND m.due_date < ? AND m.amount > COALESCE((SELECT SUM(r2.amount) FROM project_receipts r2 WHERE r2.milestone_id = m.id),0) + 0.01) AS overdue
                FROM projects p ORDER BY p.id DESC", [date('Y-m-d')])->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['contract'] = project_total($r, (float)$r['var']); $r['received'] = (float)$r['rec']; $r['overdue'] = (int)$r['overdue']; unset($r['var'], $r['rec']); }
            json_out(['projects' => $rows, 'summary' => receivables_summary()]);
        }
        if ($m === 'POST') {
            $d = body();
            $qr = q('SELECT * FROM quotes WHERE id = ?', [(int)($d['quote_id'] ?? 0)])->fetch();
            if (!$qr) fail('Quote not found', 404);
            if ($qr['status'] !== 'accepted' || !(int)$qr['is_latest']) fail('Only an accepted (latest) quotation can be converted to a project');
            if (q('SELECT 1 FROM projects WHERE quote_no = ?', [$qr['quote_no']])->fetch()) fail('A project already exists for this quotation');
            $data = json_decode((string)$qr['data'], true) ?: [];
            $client = json_decode((string)$qr['client_json'], true) ?: [];
            $name = $qr['title'] !== '' ? $qr['title'] : ($client['name'] ?? $qr['quote_no']);
            db()->beginTransaction();
            q('INSERT INTO projects (quote_no,name,client_id,division,status,base_value,tax_rate,start_date,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                [$qr['quote_no'], $name, $qr['client_id'], $qr['division'], 'active', (float)$qr['total'], (float)($data['tax_rate'] ?? 18), date('Y-m-d'), now()]);
            $pid = (int)db()->lastInsertId();
            $i = 0;
            foreach (($data['payment_schedule'] ?? []) as $s) {
                $pct = num($s['percent'] ?? 0);
                q('INSERT INTO project_milestones (project_id,label,percent,amount,sort) VALUES (?,?,?,?,?)', [$pid, str($s['label'] ?? '', 190), $pct, round((float)$qr['total'] * $pct / 100, 2), $i++]);
            }
            db()->commit();
            json_out(['id' => $pid], 201);
        }
        fail('Not found', 404);
    }

    if (!q('SELECT 1 FROM projects WHERE id = ?', [$id])->fetch()) fail('Project not found', 404);

    if ($sub === null) {
        if ($m === 'GET') json_out(project_detail($id));
        if ($m === 'PUT') {
            $d = body();
            $st = in_array($d['status'] ?? '', ['active', 'on_hold', 'completed'], true) ? $d['status'] : 'active';
            q('UPDATE projects SET name=?, status=?, start_date=?, end_date=?, notes=? WHERE id=?', [str($d['name'] ?? '', 255) ?: 'Project', $st, pdate($d['start_date'] ?? null), pdate($d['end_date'] ?? null), str($d['notes'] ?? '', 3000), $id]);
            json_out(['ok' => true]);
        }
        if ($m === 'DELETE') {
            require_admin();
            foreach (['project_milestones', 'project_receipts', 'project_variations', 'project_log'] as $t) q("DELETE FROM $t WHERE project_id = ?", [$id]);
            q('DELETE FROM projects WHERE id = ?', [$id]);
            json_out(['ok' => true]);
        }
    }

    if ($sub === 'milestones') {
        if ($m === 'POST' && $sid === null) {
            $d = body();
            q('INSERT INTO project_milestones (project_id,label,percent,amount,due_date,sort) VALUES (?,?,?,?,?,?)', [$id, str($d['label'] ?? '', 190) ?: 'Milestone', 0, round(max(num($d['amount'] ?? 0), 0), 2), pdate($d['due_date'] ?? null), 999]);
            json_out(['id' => (int)db()->lastInsertId()], 201);
        }
        if ($sid !== null && !q('SELECT 1 FROM project_milestones WHERE id = ? AND project_id = ?', [$sid, $id])->fetch()) fail('Milestone not found', 404);
        if ($m === 'PUT' && $sid !== null) {
            $d = body();
            q('UPDATE project_milestones SET label=?, due_date=?, amount=? WHERE id=?', [str($d['label'] ?? '', 190) ?: 'Milestone', pdate($d['due_date'] ?? null), round(max(num($d['amount'] ?? 0), 0), 2), $sid]);
            json_out(['ok' => true]);
        }
        if ($m === 'DELETE' && $sid !== null) {
            if (q('SELECT 1 FROM project_receipts WHERE milestone_id = ?', [$sid])->fetch()) fail('Delete the receipts against this milestone first');
            q('DELETE FROM project_milestones WHERE id = ?', [$sid]);
            json_out(['ok' => true]);
        }
        if ($m === 'POST' && $sid !== null && ($p[3] ?? '') === 'invoice') {
            $ms = q('SELECT * FROM project_milestones WHERE id = ?', [$sid])->fetch();
            if (!$ms['invoice_no']) {
                $today = date('Y-m-d');
                q('UPDATE project_milestones SET invoice_no=?, invoice_date=? WHERE id=?', [next_invoice_no($today), $today, $sid]);
            }
            json_out(['ok' => true]);
        }
    }

    if ($sub === 'receipts') {
        if ($m === 'POST') {
            $d = body();
            $amt = round(num($d['amount'] ?? 0), 2);
            if ($amt <= 0) fail('Enter the amount received');
            $mid = (int)($d['milestone_id'] ?? 0) ?: null;
            if ($mid && !q('SELECT 1 FROM project_milestones WHERE id = ? AND project_id = ?', [$mid, $id])->fetch()) $mid = null;
            q('INSERT INTO project_receipts (project_id,milestone_id,amount,received_on,mode,reference,note,created_at) VALUES (?,?,?,?,?,?,?,?)',
                [$id, $mid, $amt, pdate($d['received_on'] ?? null) ?: date('Y-m-d'), str($d['mode'] ?? '', 30), str($d['reference'] ?? '', 120), str($d['note'] ?? '', 255), now()]);
            json_out(['id' => (int)db()->lastInsertId()], 201);
        }
        if ($m === 'DELETE' && $sid !== null) { q('DELETE FROM project_receipts WHERE id = ? AND project_id = ?', [$sid, $id]); json_out(['ok' => true]); }
    }

    if ($sub === 'variations') {
        if ($m === 'POST') {
            $d = body();
            $t = str($d['title'] ?? '', 255);
            if ($t === '') fail('Describe the variation');
            q('INSERT INTO project_variations (project_id,title,note,amount,status,created_at) VALUES (?,?,?,?,?,?)', [$id, $t, str($d['note'] ?? '', 1000), round(num($d['amount'] ?? 0), 2), 'proposed', now()]);
            json_out(['id' => (int)db()->lastInsertId()], 201);
        }
        $v = $sid !== null ? q('SELECT * FROM project_variations WHERE id = ? AND project_id = ?', [$sid, $id])->fetch() : null;
        if ($m === 'POST' || $v === null && $sid !== null) fail('Variation not found', 404);
        if ($m === 'PUT' && $v) {
            $d = body();
            $new = in_array($d['status'] ?? '', ['proposed', 'approved', 'rejected'], true) ? $d['status'] : $v['status'];
            $pr = q('SELECT tax_rate FROM projects WHERE id = ?', [$id])->fetch();
            $amt = round(num($d['amount'] ?? $v['amount']), 2);
            $mid = $v['milestone_id'] !== null ? (int)$v['milestone_id'] : null;
            db()->beginTransaction();
            if ($new === 'approved' && !$mid) {
                q('INSERT INTO project_milestones (project_id,label,percent,amount,kind,sort) VALUES (?,?,?,?,?,?)', [$id, 'Variation: ' . str($d['title'] ?? $v['title'], 160), 0, round($amt * (1 + (float)$pr['tax_rate'] / 100), 2), 'variation', 1000]);
                $mid = (int)db()->lastInsertId();
            } elseif ($new !== 'approved' && $mid) {
                $ms = q('SELECT invoice_no FROM project_milestones WHERE id = ?', [$mid])->fetch();
                if (($ms && $ms['invoice_no']) || q('SELECT 1 FROM project_receipts WHERE milestone_id = ?', [$mid])->fetch()) { db()->rollBack(); fail('This variation is already invoiced or paid and cannot be un-approved'); }
                q('DELETE FROM project_milestones WHERE id = ?', [$mid]); $mid = null;
            } elseif ($new === 'approved' && $mid) {
                q('UPDATE project_milestones SET amount = ? WHERE id = ? AND invoice_no IS NULL', [round($amt * (1 + (float)$pr['tax_rate'] / 100), 2), $mid]);
            }
            q('UPDATE project_variations SET title=?, note=?, amount=?, status=?, milestone_id=? WHERE id=?', [str($d['title'] ?? $v['title'], 255), str($d['note'] ?? $v['note'], 1000), $amt, $new, $mid, $sid]);
            db()->commit();
            json_out(['ok' => true]);
        }
        if ($m === 'DELETE' && $v) {
            if ($v['milestone_id']) {
                $mid = (int)$v['milestone_id'];
                $ms = q('SELECT invoice_no FROM project_milestones WHERE id = ?', [$mid])->fetch();
                if (($ms && $ms['invoice_no']) || q('SELECT 1 FROM project_receipts WHERE milestone_id = ?', [$mid])->fetch()) fail('This variation is already invoiced or paid');
                q('DELETE FROM project_milestones WHERE id = ?', [$mid]);
            }
            q('DELETE FROM project_variations WHERE id = ?', [$sid]);
            json_out(['ok' => true]);
        }
    }

    if ($sub === 'log') {
        if ($m === 'POST') {
            $d = body();
            $t = str($d['text'] ?? '', 2000);
            if ($t === '') fail('Write the update');
            $pg = isset($d['progress']) && $d['progress'] !== '' ? max(0, min(100, (int)$d['progress'])) : null;
            q('INSERT INTO project_log (project_id,log_date,text,progress,author,created_at) VALUES (?,?,?,?,?,?)', [$id, pdate($d['log_date'] ?? null) ?: date('Y-m-d'), $t, $pg, $user['name'], now()]);
            json_out(['id' => (int)db()->lastInsertId()], 201);
        }
        if ($m === 'DELETE' && $sid !== null) { q('DELETE FROM project_log WHERE id = ? AND project_id = ?', [$sid, $id]); json_out(['ok' => true]); }
    }
    fail('Not found', 404);
}
