<?php
declare(strict_types=1);
// Projects: created from accepted quotes. Billing milestones, receipts, variation orders, site log, tax invoices.

function pdate($v): ?string
{
    return preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$v) ? (string)$v : null;
}

function project_total(array $p, float $approvedVar, float $credits = 0.0): float
{
    return round((float)$p['base_value'] + $approvedVar * (1 + (float)$p['tax_rate'] / 100) - $credits, 2);
}

/** Next sequential document number, e.g. INF/INV/26-27/0007. Numbers of cancelled documents stay used (no gaps, no reuse). */
function next_doc_no(string $kind, array $sources, string $date): string
{
    $prefix = (string)(get_setting('quote_prefix') ?: 'INF');
    $head = $prefix . '/' . $kind . '/' . financial_year($date) . '/';
    $max = 0;
    foreach ($sources as [$table, $col]) foreach (q("SELECT $col AS n FROM $table WHERE $col LIKE ?", [$head . '%'])->fetchAll() as $r) $max = max($max, (int)substr((string)$r['n'], strlen($head)));
    return $head . str_pad((string)($max + 1), 4, '0', STR_PAD_LEFT);
}
function next_invoice_no(string $date): string { return next_doc_no('INV', [['project_milestones', 'invoice_no'], ['invoice_history', 'invoice_no']], $date); }
function next_credit_no(string $date): string { return next_doc_no('CN', [['credit_notes', 'credit_no']], $date); }
function next_receipt_no(string $date): string { return next_doc_no('RC', [['project_receipts', 'receipt_no']], $date); }

function project_detail(int $id): array
{
    $p = q('SELECT * FROM projects WHERE id = ?', [$id])->fetch();
    if (!$p) fail('Project not found', 404);
    $ms = q('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort, id', [$id])->fetchAll();
    $rc = q('SELECT * FROM project_receipts WHERE project_id = ? ORDER BY received_on, id', [$id])->fetchAll();
    $vr = q('SELECT * FROM project_variations WHERE project_id = ? ORDER BY id', [$id])->fetchAll();
    $lg = q('SELECT * FROM project_log WHERE project_id = ? ORDER BY log_date DESC, id DESC LIMIT 100', [$id])->fetchAll();
    $cn = q('SELECT * FROM credit_notes WHERE project_id = ? ORDER BY id', [$id])->fetchAll();
    $ih = q('SELECT * FROM invoice_history WHERE project_id = ? ORDER BY id', [$id])->fetchAll();
    foreach ($lg as &$l) { $l['id'] = (int)$l['id']; $l['photos'] = json_decode((string)($l['photos'] ?? ''), true) ?: []; }
    $paid = []; $credited = [];
    foreach ($rc as &$r) {
        $r['id'] = (int)$r['id']; $r['amount'] = (float)$r['amount']; $r['milestone_id'] = $r['milestone_id'] !== null ? (int)$r['milestone_id'] : null;
        if ($r['milestone_id']) $paid[$r['milestone_id']] = ($paid[$r['milestone_id']] ?? 0) + $r['amount'];
    }
    foreach ($cn as &$x) { $x['id'] = (int)$x['id']; $x['milestone_id'] = (int)$x['milestone_id']; $x['amount'] = (float)$x['amount']; $credited[$x['milestone_id']] = ($credited[$x['milestone_id']] ?? 0) + $x['amount']; }
    $billed = 0.0; $today = date('Y-m-d');
    foreach ($ms as &$m) {
        $m['id'] = (int)$m['id']; $m['amount'] = (float)$m['amount']; $m['percent'] = (float)$m['percent'];
        $m['paid'] = round($paid[$m['id']] ?? 0, 2);
        $m['credited'] = round($credited[$m['id']] ?? 0, 2);
        $m['net'] = round($m['amount'] - $m['credited'], 2);
        if ($m['net'] <= 0.01 && $m['credited'] > 0) $m['state'] = 'credited';
        else $m['state'] = $m['paid'] >= $m['net'] - 0.01 && $m['net'] > 0 ? 'paid' : ($m['paid'] > 0 ? 'part' : ($m['invoice_no'] ? 'invoiced' : 'pending'));
        $m['overdue'] = !in_array($m['state'], ['paid', 'credited'], true) && $m['due_date'] && $m['due_date'] < $today;
        $billed += $m['net'];
    }
    $appr = 0.0;
    foreach ($vr as &$v) { $v['id'] = (int)$v['id']; $v['amount'] = (float)$v['amount']; if ($v['status'] === 'approved') $appr += $v['amount']; }
    $creditTotal = round(array_sum($credited), 2);
    $total = project_total($p, $appr, $creditTotal);
    $received = round(array_sum(array_column($rc, 'amount')), 2);
    $p['id'] = (int)$p['id']; $p['client_id'] = $p['client_id'] !== null ? (int)$p['client_id'] : null; $p['base_value'] = (float)$p['base_value']; $p['tax_rate'] = (float)$p['tax_rate'];
    $quote = q('SELECT id,quote_no,rev,title,client_json,data,valid_until FROM quotes WHERE quote_no = ? AND is_latest = 1', [$p['quote_no']])->fetch();
    $qd = $quote ? (json_decode((string)$quote['data'], true) ?: []) : [];
    return ['project' => $p, 'milestones' => $ms, 'receipts' => $rc, 'variations' => $vr, 'log' => $lg, 'credit_notes' => $cn, 'invoice_history' => $ih,
        'totals' => ['contract' => $total, 'variations' => round($appr * (1 + (float)$p['tax_rate'] / 100), 2), 'credits' => $creditTotal, 'billed' => round($billed, 2), 'received' => $received, 'outstanding' => round($total - $received, 2)],
        'quote' => $quote ? ['id' => (int)$quote['id'], 'quote_no' => $quote['quote_no'], 'client' => json_decode((string)$quote['client_json'], true) ?: new stdClass(), 'gst_mode' => $qd['gst_mode'] ?? '', 'hsn' => $qd['hsn'] ?? ''] : null];
}

function receivables_summary(): array
{
    $rows = q("SELECT p.id, p.base_value, p.tax_rate, p.status,
        (SELECT COALESCE(SUM(v.amount),0) FROM project_variations v WHERE v.project_id = p.id AND v.status = 'approved') AS varsum,
        (SELECT COALESCE(SUM(c.amount),0) FROM credit_notes c WHERE c.project_id = p.id) AS credits,
        (SELECT COALESCE(SUM(r.amount),0) FROM project_receipts r WHERE r.project_id = p.id) AS rec FROM projects p")->fetchAll();
    $contract = 0.0; $rec = 0.0; $active = 0;
    foreach ($rows as $r) { $contract += project_total($r, (float)$r['varsum'], (float)$r['credits']); $rec += (float)$r['rec']; if ($r['status'] === 'active') $active++; }
    $today = date('Y-m-d');
    $od = q("SELECT COUNT(*) AS n FROM project_milestones m WHERE m.due_date IS NOT NULL AND m.due_date < ? AND m.amount - COALESCE((SELECT SUM(c.amount) FROM credit_notes c WHERE c.milestone_id = m.id),0) > COALESCE((SELECT SUM(r.amount) FROM project_receipts r WHERE r.milestone_id = m.id),0) + 0.01", [$today])->fetch();
    return ['projects' => count($rows), 'active' => $active, 'contract' => round($contract, 2), 'received' => round($rec, 2), 'outstanding' => round($contract - $rec, 2), 'overdue' => (int)$od['n']];
}

/** Create a project (with milestones from the payment schedule) from an accepted quote row. Caller has validated the quote. */
function create_project_from_quote(array $qr): int
{
    $data = json_decode((string)$qr['data'], true) ?: [];
    $client = json_decode((string)$qr['client_json'], true) ?: [];
    $name = $qr['title'] !== '' ? $qr['title'] : ($client['name'] ?? $qr['quote_no']);
    db()->beginTransaction();
    q('INSERT INTO projects (quote_no,name,client_id,division,status,base_value,tax_rate,start_date,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [$qr['quote_no'], $name, $qr['client_id'], $qr['division'], 'active', (float)$qr['total'], (float)($data['tax_rate'] ?? 18), date('Y-m-d'), now()]);
    $pid = (int)db()->lastInsertId();
    $i = 0; $left = round((float)$qr['total'], 2);
    $sched = array_values($data['payment_schedule'] ?? []);
    $pctSum = array_sum(array_map(fn($s) => num($s['percent'] ?? 0), $sched));
    foreach ($sched as $k => $s) {
        $pct = num($s['percent'] ?? 0);
        $amt = round((float)$qr['total'] * $pct / 100, 2);
        // when the stages add up to 100%, the last one absorbs rounding so milestones always equal the contract exactly
        if ($k === count($sched) - 1 && abs($pctSum - 100) < 0.01) $amt = round($left, 2);
        $left -= $amt;
        q('INSERT INTO project_milestones (project_id,label,percent,amount,sort) VALUES (?,?,?,?,?)', [$pid, str($s['label'] ?? '', 190), $pct, $amt, $i++]);
    }
    db()->commit();
    return $pid;
}

/** Create the billing milestone for an approved variation (amount ex-GST -> milestone incl. GST). Returns the milestone id. */
function variation_milestone(int $projectId, array $v): int
{
    $pr = q('SELECT tax_rate FROM projects WHERE id = ?', [$projectId])->fetch();
    q('INSERT INTO project_milestones (project_id,label,percent,amount,kind,sort) VALUES (?,?,?,?,?,?)', [$projectId, 'Variation: ' . str($v['title'], 160), 0, round((float)$v['amount'] * (1 + (float)$pr['tax_rate'] / 100), 2), 'variation', 1000]);
    return (int)db()->lastInsertId();
}

function projects_route(string $m, array $p, array $user): void
{
    $id = isset($p[0]) && ctype_digit($p[0]) ? (int)$p[0] : null;
    $sub = $p[1] ?? null;
    $sid = isset($p[2]) && ctype_digit($p[2]) ? (int)$p[2] : null;

    if ($id === null) {
        if ($m === 'GET') {
            $rows = q("SELECT p.*, (SELECT COALESCE(SUM(v.amount),0) FROM project_variations v WHERE v.project_id = p.id AND v.status = 'approved') AS varsum,
                (SELECT COALESCE(SUM(c.amount),0) FROM credit_notes c WHERE c.project_id = p.id) AS credits,
                (SELECT COALESCE(SUM(r.amount),0) FROM project_receipts r WHERE r.project_id = p.id) AS rec,
                (SELECT c.name FROM clients c WHERE c.id = p.client_id) AS client_name,
                (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = p.id AND m.due_date IS NOT NULL AND m.due_date < ? AND m.amount - COALESCE((SELECT SUM(c2.amount) FROM credit_notes c2 WHERE c2.milestone_id = m.id),0) > COALESCE((SELECT SUM(r2.amount) FROM project_receipts r2 WHERE r2.milestone_id = m.id),0) + 0.01) AS overdue
                FROM projects p ORDER BY p.id DESC", [date('Y-m-d')])->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['contract'] = project_total($r, (float)$r['varsum'], (float)$r['credits']); $r['received'] = (float)$r['rec']; $r['overdue'] = (int)$r['overdue']; unset($r['varsum'], $r['rec'], $r['credits']); }
            json_out(['projects' => $rows, 'summary' => receivables_summary()]);
        }
        if ($m === 'POST') {
            $d = body();
            $qr = q('SELECT * FROM quotes WHERE id = ?', [(int)($d['quote_id'] ?? 0)])->fetch();
            if (!$qr) fail('Quote not found', 404);
            if ($qr['status'] !== 'accepted' || !(int)$qr['is_latest']) fail('Only an accepted (latest) quotation can be converted to a project');
            if ((float)$qr['total'] <= 0) fail('This quotation has no value to bill');
            if (q('SELECT 1 FROM projects WHERE quote_no = ?', [$qr['quote_no']])->fetch()) fail('A project already exists for this quotation');
            $pid = create_project_from_quote($qr);
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
            q('UPDATE projects SET name=?, status=?, start_date=?, end_date=?, notes=?, amc_end=?, amc_note=? WHERE id=?', [str($d['name'] ?? '', 255) ?: 'Project', $st, pdate($d['start_date'] ?? null), pdate($d['end_date'] ?? null), str($d['notes'] ?? '', 3000), pdate($d['amc_end'] ?? null), str($d['amc_note'] ?? '', 255) ?: null, $id]);
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
            $cur = q('SELECT label, amount, invoice_no FROM project_milestones WHERE id = ?', [$sid])->fetch();
            if ($cur['invoice_no'] && (abs((float)$cur['amount'] - round(num($d['amount'] ?? 0), 2)) > 0.001 || trim((string)$cur['label']) !== str($d['label'] ?? '', 190))) fail('This milestone has been invoiced, so its stage name and amount can no longer change (only the due date).', 409);
            q('UPDATE project_milestones SET label=?, due_date=?, amount=? WHERE id=?', [str($d['label'] ?? '', 190) ?: 'Milestone', pdate($d['due_date'] ?? null), round(max(num($d['amount'] ?? 0), 0), 2), $sid]);
            json_out(['ok' => true]);
        }
        if ($m === 'DELETE' && $sid !== null) {
            if (q('SELECT 1 FROM project_receipts WHERE milestone_id = ?', [$sid])->fetch()) fail('Delete the receipts against this milestone first');
            if (q('SELECT 1 FROM project_milestones WHERE id = ? AND invoice_no IS NOT NULL', [$sid])->fetch()) fail('An invoiced milestone cannot be deleted (it would leave a gap in your invoice numbers).', 409);
            q('DELETE FROM project_milestones WHERE id = ?', [$sid]);
            json_out(['ok' => true]);
        }
        if ($m === 'POST' && $sid !== null && ($p[3] ?? '') === 'cancel-invoice') {
            if (($user['role'] ?? '') !== 'admin') fail('Only an admin can cancel an invoice', 403);
            $ms = q('SELECT * FROM project_milestones WHERE id = ?', [$sid])->fetch();
            $reason = str(body()['reason'] ?? '', 255);
            if ($reason === '') fail('Give a reason for cancelling the invoice (it is kept on record)');
            if (!$ms['invoice_no']) fail('This milestone has no invoice to cancel', 409);
            if (q('SELECT 1 FROM project_receipts WHERE milestone_id = ?', [$sid])->fetch()) fail('Payments are recorded against this invoice. Delete them first, or issue a credit note instead.', 409);
            if (q('SELECT 1 FROM credit_notes WHERE milestone_id = ?', [$sid])->fetch()) fail('A credit note exists for this invoice, so it cannot be cancelled.', 409);
            db()->beginTransaction();
            q('INSERT INTO invoice_history (project_id,milestone_id,invoice_no,invoice_date,amount,status,reason,created_at) VALUES (?,?,?,?,?,?,?,?)', [$id, $sid, $ms['invoice_no'], $ms['invoice_date'], $ms['amount'], 'cancelled', $reason, now()]);
            q('UPDATE project_milestones SET invoice_no = NULL, invoice_date = NULL, irn = NULL, ack_no = NULL, ack_date = NULL WHERE id = ?', [$sid]);
            db()->commit();
            audit($user, 'invoice.cancel', $ms['invoice_no'] . ' - ' . $reason);
            json_out(['ok' => true, 'cancelled' => $ms['invoice_no'], 'note' => $ms['irn'] ? 'This invoice had an IRN. Cancel the IRN on the e-invoice portal as well (normally allowed within 24 hours of generation).' : '']);
        }
        if ($m === 'POST' && $sid !== null && ($p[3] ?? '') === 'credit-note') {
            if (($user['role'] ?? '') !== 'admin') fail('Only an admin can issue a credit note', 403);
            $ms = q('SELECT *, (SELECT COALESCE(SUM(c.amount),0) FROM credit_notes c WHERE c.milestone_id = project_milestones.id) AS credited, (SELECT COALESCE(SUM(r.amount),0) FROM project_receipts r WHERE r.milestone_id = project_milestones.id) AS paid FROM project_milestones WHERE id = ?', [$sid])->fetch();
            $d = body(); $amt = round(num($d['amount'] ?? 0), 2); $reason = str($d['reason'] ?? '', 255);
            if (!$ms['invoice_no']) fail('Only an invoiced milestone can be credited', 409);
            if ($amt <= 0) fail('Enter the credit amount (including GST)');
            if ($reason === '') fail('Give a reason for the credit note');
            $left = round((float)$ms['amount'] - (float)$ms['credited'], 2);
            if ($amt > $left + 0.01) fail('A credit note cannot exceed the invoice value still outstanding (' . number_format($left, 2) . ').');
            if ((float)$ms['paid'] > $left - $amt + 0.01) fail('Payments already received exceed the invoice value after this credit. Delete or refund the excess payment first.', 409);
            $on = pdate($d['date'] ?? null) ?: date('Y-m-d');
            q('INSERT INTO credit_notes (project_id,milestone_id,credit_no,credit_date,amount,reason,created_at) VALUES (?,?,?,?,?,?,?)', [$id, $sid, next_credit_no($on), $on, $amt, $reason, now()]);
            $cid = (int)db()->lastInsertId();
            audit($user, 'credit_note.issue', 'project #' . $id . ' ' . number_format($amt, 2) . ' - ' . $reason);
            json_out(['id' => $cid], 201);
        }
        if ($m === 'POST' && $sid !== null && ($p[3] ?? '') === 'einvoice') {
            $ms = q('SELECT invoice_no FROM project_milestones WHERE id = ?', [$sid])->fetch(); $d = body();
            if (!$ms['invoice_no']) fail('Create the invoice first', 409);
            $irn = preg_replace('/[^A-Za-z0-9]/', '', str($d['irn'] ?? '', 80));
            if ($irn !== '' && strlen($irn) !== 64) fail('An IRN is 64 characters long. Paste it exactly as shown on the e-invoice portal.');
            q('UPDATE project_milestones SET irn = ?, ack_no = ?, ack_date = ? WHERE id = ?', [$irn ?: null, str($d['ack_no'] ?? '', 40) ?: null, pdate($d['ack_date'] ?? null), $sid]);
            audit($user, 'invoice.einvoice_ref', $ms['invoice_no']);
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
            if ($mid) {
                $ms = q('SELECT amount, (SELECT COALESCE(SUM(c.amount),0) FROM credit_notes c WHERE c.milestone_id = project_milestones.id) AS credited, (SELECT COALESCE(SUM(r.amount),0) FROM project_receipts r WHERE r.milestone_id = project_milestones.id) AS paid FROM project_milestones WHERE id = ?', [$mid])->fetch();
                $bal = round((float)$ms['amount'] - (float)$ms['credited'] - (float)$ms['paid'], 2);
                if ($amt > $bal + 0.01) fail('That is more than the balance due on this milestone (' . number_format($bal, 2) . ').');
            } else {
                $det = project_detail($id);
                if ($amt > $det['totals']['outstanding'] + 0.01) fail('That is more than the total outstanding on this project (' . number_format($det['totals']['outstanding'], 2) . ').');
            }
            $on = pdate($d['received_on'] ?? null) ?: date('Y-m-d');
            q('INSERT INTO project_receipts (project_id,milestone_id,amount,received_on,mode,reference,note,receipt_no,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                [$id, $mid, $amt, $on, str($d['mode'] ?? '', 30), str($d['reference'] ?? '', 120), str($d['note'] ?? '', 255), next_receipt_no($on), now()]);
            $rid = (int)db()->lastInsertId();
            audit($user, 'payment.record', 'project #' . $id . ' ' . number_format($amt, 2));
            json_out(['id' => $rid], 201);
        }
        if ($m === 'DELETE' && $sid !== null) { if (($user['role'] ?? '') !== 'admin') fail('Only an admin can delete a recorded payment', 403); audit($user, 'payment.delete', 'receipt #' . $sid . ' project #' . $id); q('DELETE FROM project_receipts WHERE id = ? AND project_id = ?', [$sid, $id]); json_out(['ok' => true]); }
    }

    if ($sub === 'variations') {
        if ($m === 'POST' && $sid !== null && ($p[3] ?? '') === 'request-approval') {
            $v = q('SELECT * FROM project_variations WHERE id = ? AND project_id = ?', [$sid, $id])->fetch(); if (!$v) fail('Variation not found', 404);   // send the change order to the client for online approval
            if ($v['status'] !== 'proposed') fail('Only a proposed variation can be sent for approval', 409);
            if ((float)$v['amount'] <= 0) fail('Set the variation amount first');
            $tok = $v['approval_token'] ?: bin2hex(random_bytes(16));
            if (!$v['approval_token']) q('UPDATE project_variations SET approval_token = ? WHERE id = ?', [$tok, $sid]);
            $link = app_base_url() . '/approve.html?t=' . $tok; $mailed = false; $note = '';
            $proj = q('SELECT p.name, p.quote_no, p.tax_rate, c.name AS cname, c.email, c.contact_person FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?', [$id])->fetch();
            $to = strtolower(str(body()['to'] ?? '', 190)) ?: strtolower((string)($proj['email'] ?? ''));
            if (filter_var($to, FILTER_VALIDATE_EMAIL) && mail_configured()) {
                $e = fn($x) => htmlspecialchars((string)$x, ENT_QUOTES, 'UTF-8');
                $total = (float)$v['amount'] * (1 + (float)$proj['tax_rate'] / 100); $co = (string)(get_setting('company_name') ?: 'Infraura');
                [$mailed, $err] = send_mail($to, 'Change order for your approval: ' . $v['title'], email_html('Change order for approval', '<p>Dear ' . $e($proj['contact_person'] ?: $proj['cname']) . ',</p><p>We propose a change to <b>' . $e($proj['name']) . '</b>: <b>' . $e($v['title']) . '</b>. Additional cost: <b>Rs ' . number_format($total, 2) . '</b> including GST. Please review and approve online.</p>', ['Review & approve', $link]));
                if (!$mailed) $note = 'E-mail could not be sent: ' . $err;
            } else $note = 'No client e-mail on file (or e-mail not set up) - share the link yourself.';
            audit($GLOBALS['CURRENT_USER'] ?? [], 'variation.request', $proj['quote_no'] . ' / ' . $v['title']);
            json_out(['link' => $link, 'emailed' => $mailed, 'note' => $note]);
        }
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
            if ($mid && abs($amt - (float)$v['amount']) > 0.001 && q('SELECT 1 FROM project_milestones WHERE id = ? AND invoice_no IS NOT NULL', [$mid])->fetch()) fail('This variation has been invoiced - its amount can no longer change.', 409);
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
            $photos = [];
            foreach ((is_array($d['photos'] ?? null) ? $d['photos'] : []) as $ph) {
                if (is_string($ph) && count($photos) < 3 && strlen($ph) <= 220000 && preg_match('#^data:image/(jpeg|png);base64,[A-Za-z0-9+/=]+$#', $ph)) $photos[] = $ph;
            }
            q('INSERT INTO project_log (project_id,log_date,text,progress,author,photos,created_at) VALUES (?,?,?,?,?,?,?)', [$id, pdate($d['log_date'] ?? null) ?: date('Y-m-d'), $t, $pg, $user['name'], $photos ? json_encode($photos) : null, now()]);
            json_out(['id' => (int)db()->lastInsertId()], 201);
        }
        if ($m === 'DELETE' && $sid !== null) { q('DELETE FROM project_log WHERE id = ? AND project_id = ?', [$sid, $id]); json_out(['ok' => true]); }
    }
    fail('Not found', 404);
}
