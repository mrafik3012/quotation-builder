<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
start_session();

$method = $_SERVER['REQUEST_METHOD'];
$parts = array_values(array_filter(explode('/', trim((string)($_GET['r'] ?? ''), '/')), 'strlen'));
$a = $parts[0] ?? '';
$b = $parts[1] ?? null;
$c = $parts[2] ?? null;

if ($method !== 'GET' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'infraura') {
    fail('Bad request', 403);
}

try {
    route($method, $a, $b, $c);
} catch (PDOException $e) {
    error_log('DB error: ' . $e->getMessage());
    fail('Database error', 500);
} catch (Throwable $e) {
    error_log('Error: ' . $e->getMessage());
    fail('Server error', 500);
}

function route(string $m, string $a, ?string $b, ?string $c): void
{
    // ---- auth ----
    if ($a === 'auth') {
        if ($b === 'login' && $m === 'POST') {
            $d = body();
            $email = strtolower(str($d['email'] ?? '', 190));
            $u = q('SELECT * FROM users WHERE email = ?', [$email])->fetch();
            if (!$u || !password_verify((string)($d['password'] ?? ''), $u['password_hash'])) {
                usleep(800000);
                fail('Incorrect email or password', 401);
            }
            session_regenerate_id(true);
            $_SESSION['user'] = ['id' => (int)$u['id'], 'name' => $u['name'], 'email' => $u['email'], 'role' => $u['role']];
            json_out(['user' => $_SESSION['user']]);
        }
        if ($b === 'logout' && $m === 'POST') {
            $_SESSION = [];
            session_destroy();
            json_out(['ok' => true]);
        }
        if ($b === 'me' && $m === 'GET') {
            json_out(['user' => current_user()]);
        }
        if ($b === 'password' && $m === 'POST') {
            $u = require_auth();
            $d = body();
            $row = q('SELECT password_hash FROM users WHERE id = ?', [$u['id']])->fetch();
            if (!password_verify((string)($d['current'] ?? ''), $row['password_hash'])) fail('Current password is wrong');
            $new = (string)($d['new'] ?? '');
            if (strlen($new) < 8) fail('New password must be at least 8 characters');
            q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($new, PASSWORD_DEFAULT), $u['id']]);
            json_out(['ok' => true]);
        }
        fail('Not found', 404);
    }

    $user = require_auth();

    switch ($a) {
        case 'bootstrap': // everything the UI needs after login
            json_out([
                'user' => $user,
                'settings' => all_settings(),
                'clients' => q('SELECT id,name,contact_person,phone,email,address,gstin FROM clients ORDER BY name')->fetchAll(),
                'rates' => rates_list(),
                'divisions' => DIVISIONS,
            ]);

        case 'dashboard':
            json_out(dashboard());

        case 'settings':
            if ($m === 'GET') json_out(all_settings());
            if ($m === 'PUT') {
                require_admin();
                $d = body();
                $allowed = array_keys(all_settings());
                foreach ($d as $k => $v) {
                    if (!in_array($k, $allowed, true)) continue;
                    $v = (string)$v;
                    if ($k === 'company_logo' && strlen($v) > 600000) fail('Logo too large (max ~400 KB)');
                    set_setting($k, $v);
                }
                json_out(all_settings());
            }
            break;

        case 'users':
            require_admin();
            if ($m === 'GET') json_out(q('SELECT id,name,email,role,created_at FROM users ORDER BY id')->fetchAll());
            if ($m === 'POST') {
                $d = body();
                $email = strtolower(str($d['email'] ?? '', 190));
                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Valid email required');
                if (strlen((string)($d['password'] ?? '')) < 8) fail('Password must be at least 8 characters');
                if (q('SELECT 1 FROM users WHERE email = ?', [$email])->fetch()) fail('Email already exists');
                $role = ($d['role'] ?? '') === 'admin' ? 'admin' : 'staff';
                q('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)',
                    [str($d['name'] ?? '', 120) ?: 'User', $email, password_hash((string)$d['password'], PASSWORD_DEFAULT), $role, now()]);
                json_out(['ok' => true], 201);
            }
            if ($m === 'DELETE' && $b !== null) {
                if ((int)$b === $user['id']) fail('You cannot delete yourself');
                q('DELETE FROM users WHERE id = ?', [(int)$b]);
                json_out(['ok' => true]);
            }
            break;

        case 'clients':
            clients_route($m, $b);
            break;

        case 'rates':
            rates_route($m, $b);
            break;

        case 'quotes':
            quotes_route($m, $b, $c, $user);
            break;
    }
    fail('Not found', 404);
}

function all_settings(): array
{
    $out = [];
    foreach (q('SELECT k, v FROM settings')->fetchAll() as $r) $out[$r['k']] = (string)$r['v'];
    return $out;
}

// ---------------- clients ----------------
function client_fields(array $d): array
{
    $name = str($d['name'] ?? '', 190);
    if ($name === '') fail('Client name is required');
    return [$name, str($d['contact_person'] ?? '', 120), str($d['phone'] ?? '', 40), str($d['email'] ?? '', 190), str($d['address'] ?? '', 1000), str($d['gstin'] ?? '', 30)];
}

function clients_route(string $m, ?string $b): void
{
    if ($m === 'GET') {
        json_out(q('SELECT c.*, (SELECT COUNT(*) FROM quotes x WHERE x.client_id = c.id AND x.is_latest = 1) AS quote_count FROM clients c ORDER BY c.name')->fetchAll());
    }
    if ($m === 'POST') {
        $f = client_fields(body());
        q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)', array_merge($f, [now()]));
        json_out(['id' => (int)db()->lastInsertId()], 201);
    }
    if ($m === 'PUT' && $b !== null) {
        $f = client_fields(body());
        q('UPDATE clients SET name=?,contact_person=?,phone=?,email=?,address=?,gstin=? WHERE id=?', array_merge($f, [(int)$b]));
        json_out(['ok' => true]);
    }
    if ($m === 'DELETE' && $b !== null) {
        $n = (int)q('SELECT COUNT(*) AS n FROM quotes WHERE client_id = ?', [(int)$b])->fetch()['n'];
        if ($n > 0) fail("This client has $n quote(s) and cannot be deleted");
        q('DELETE FROM clients WHERE id = ?', [(int)$b]);
        json_out(['ok' => true]);
    }
    fail('Not found', 404);
}

// ---------------- rates ----------------
function rates_list(?string $division = null): array
{
    $sql = 'SELECT id,division,category,name,unit,rate,description,active,sort FROM rate_items';
    $p = [];
    if ($division) {
        $sql .= ' WHERE division = ?';
        $p[] = $division;
    }
    $rows = q($sql . ' ORDER BY division, category, sort, name', $p)->fetchAll();
    foreach ($rows as &$r) {
        $r['id'] = (int)$r['id'];
        $r['rate'] = (float)$r['rate'];
        $r['active'] = (int)$r['active'];
    }
    return $rows;
}

function rate_fields(array $d): array
{
    $div = (string)($d['division'] ?? '');
    if (!isset(DIVISIONS[$div])) fail('Invalid division');
    $name = str($d['name'] ?? '', 255);
    if ($name === '') fail('Item name is required');
    return [$div, str($d['category'] ?? '', 120), $name, str($d['unit'] ?? '', 30), round(num($d['rate'] ?? 0), 2), str($d['description'] ?? '', 1000), empty($d['active']) && array_key_exists('active', $d) ? 0 : 1];
}

function rates_route(string $m, ?string $b): void
{
    if ($m === 'GET') json_out(rates_list(isset($_GET['division']) ? (string)$_GET['division'] : null));
    if ($m === 'POST' && $b === 'import') {
        $d = body();
        $items = $d['items'] ?? [];
        if (!is_array($items) || !$items) fail('No rows to import');
        if (count($items) > 2000) fail('Too many rows (max 2000)');
        $n = 0;
        db()->beginTransaction();
        foreach ($items as $it) {
            if (!is_array($it)) continue;
            $f = rate_fields($it);
            q('INSERT INTO rate_items (division,category,name,unit,rate,description,active,sort) VALUES (?,?,?,?,?,?,?,9999)', $f);
            $n++;
        }
        db()->commit();
        json_out(['imported' => $n], 201);
    }
    if ($m === 'POST') {
        $f = rate_fields(body());
        q('INSERT INTO rate_items (division,category,name,unit,rate,description,active,sort) VALUES (?,?,?,?,?,?,?,9999)', $f);
        json_out(['id' => (int)db()->lastInsertId()], 201);
    }
    if ($m === 'PUT' && $b !== null) {
        $f = rate_fields(body());
        q('UPDATE rate_items SET division=?,category=?,name=?,unit=?,rate=?,description=?,active=? WHERE id=?', array_merge($f, [(int)$b]));
        json_out(['ok' => true]);
    }
    if ($m === 'DELETE' && $b !== null) {
        q('DELETE FROM rate_items WHERE id = ?', [(int)$b]);
        json_out(['ok' => true]);
    }
    fail('Not found', 404);
}

// ---------------- quotes ----------------
function quote_row_out(array $r, bool $full): array
{
    foreach (['id', 'rev', 'is_latest', 'client_id', 'created_by'] as $k) {
        if (isset($r[$k])) $r[$k] = (int)$r[$k];
    }
    foreach (['subtotal', 'discount', 'tax', 'round_off', 'total'] as $k) $r[$k] = (float)$r[$k];
    $r['client'] = json_decode((string)($r['client_json'] ?? ''), true) ?: new stdClass();
    unset($r['client_json']);
    if ($full) {
        $r['data'] = json_decode((string)($r['data'] ?? ''), true) ?: new stdClass();
    } else {
        unset($r['data']);
    }
    return $r;
}

function clean_quote_input(array $d, ?string $existingDivision = null): array
{
    $division = $existingDivision ?? (string)($d['division'] ?? '');
    if (!isset(DIVISIONS[$division])) fail('Invalid division');
    $title = str($d['title'] ?? '', 255);
    $data = $d['data'] ?? [];
    if (!is_array($data)) fail('Invalid quote data');
    $secs = [];
    foreach (($data['sections'] ?? []) as $s) {
        if (!is_array($s)) continue;
        $items = [];
        foreach (($s['items'] ?? []) as $it) {
            if (!is_array($it)) continue;
            $items[] = [
                'desc' => str($it['desc'] ?? '', 1000), 'unit' => str($it['unit'] ?? '', 30),
                'qty' => num($it['qty'] ?? 0), 'rate' => num($it['rate'] ?? 0), 'note' => str($it['note'] ?? '', 500),
            ];
        }
        $secs[] = ['title' => str($s['title'] ?? '', 190), 'items' => $items];
    }
    $pay = [];
    foreach (($data['payment_schedule'] ?? []) as $p) {
        if (is_array($p) && str($p['label'] ?? '') !== '') $pay[] = ['label' => str($p['label'], 190), 'percent' => num($p['percent'] ?? 0)];
    }
    $terms = [];
    foreach (($data['terms'] ?? []) as $t) {
        if (is_string($t) && trim($t) !== '') $terms[] = mb_substr(trim($t), 0, 600);
    }
    $disc = is_array($data['discount'] ?? null) ? $data['discount'] : [];
    $clean = [
        'sections' => $secs,
        'discount' => ['type' => ($disc['type'] ?? 'percent') === 'flat' ? 'flat' : 'percent', 'value' => max(0, num($disc['value'] ?? 0))],
        'tax_rate' => min(max(num($data['tax_rate'] ?? 18), 0), 100),
        'round_off' => !empty($data['round_off']),
        'payment_schedule' => $pay,
        'terms' => $terms,
        'notes' => str($data['notes'] ?? '', 3000),
        'scope' => str($data['scope'] ?? '', 3000),
        'site_address' => str($data['site_address'] ?? '', 500),
        'area_sqft' => num($data['area_sqft'] ?? 0),
        'pmc' => is_array($data['pmc'] ?? null) ? $data['pmc'] : null,
        'roofcalc' => clean_roofcalc($data['roofcalc'] ?? null),
    ];
    $c = is_array($d['client'] ?? null) ? $d['client'] : [];
    $client = ['name' => str($c['name'] ?? '', 190), 'contact_person' => str($c['contact_person'] ?? '', 120), 'phone' => str($c['phone'] ?? '', 40),
        'email' => str($c['email'] ?? '', 190), 'address' => str($c['address'] ?? '', 1000), 'gstin' => str($c['gstin'] ?? '', 30)];
    $date = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($d['quote_date'] ?? '')) ? $d['quote_date'] : date('Y-m-d');
    $valid = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($d['valid_until'] ?? '')) ? $d['valid_until'] : date('Y-m-d', strtotime($date . ' +' . (int)(get_setting('validity_days') ?: 15) . ' days'));
    return [$division, $title, $clean, $client, $date, $valid, (int)($d['client_id'] ?? 0) ?: null];
}

function clean_roofcalc($r): ?array
{
    if (!is_array($r)) return null;
    $out = [];
    foreach (['type', 'gutter'] as $k) $out[$k] = str($r[$k] ?? '', 10);
    foreach (['len', 'wid', 'slope', 'eave', 'gable', 'height', 'waste', 'pspace', 'purlinkg', 'framekg', 'screws', 'turbo', 'sky'] as $k) $out[$k] = isset($r[$k]) && $r[$k] !== '' ? num($r[$k]) : '';
    $out['mats'] = array_values(array_filter(array_map(fn($x) => str($x, 12), is_array($r['mats'] ?? null) ? $r['mats'] : []), 'strlen'));
    $out['custom'] = [];
    foreach ((is_array($r['custom'] ?? null) ? $r['custom'] : []) as $k => $v) {
        if ($v !== '' && is_numeric($v)) $out['custom'][str($k, 20)] = (float)$v;
    }
    return $out;
}

function resolve_client(?int $clientId, array $client): array
{
    if ($clientId) {
        $ex = q('SELECT 1 FROM clients WHERE id = ?', [$clientId])->fetch();
        if (!$ex) $clientId = null;
    }
    if (!$clientId && $client['name'] !== '') {
        q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)',
            [$client['name'], $client['contact_person'], $client['phone'], $client['email'], $client['address'], $client['gstin'], now()]);
        $clientId = (int)db()->lastInsertId();
    }
    return [$clientId, $client];
}

function quotes_route(string $m, ?string $b, ?string $c, array $user): void
{
    if ($m === 'GET' && $b === null) {
        $where = [];
        $p = [];
        if (empty($_GET['all'])) $where[] = 'is_latest = 1';
        if (!empty($_GET['status']) && in_array($_GET['status'], STATUSES, true)) { $where[] = 'status = ?'; $p[] = $_GET['status']; }
        if (!empty($_GET['division']) && isset(DIVISIONS[$_GET['division']])) { $where[] = 'division = ?'; $p[] = $_GET['division']; }
        if (!empty($_GET['client_id'])) { $where[] = 'client_id = ?'; $p[] = (int)$_GET['client_id']; }
        if (!empty($_GET['q'])) {
            $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], trim((string)$_GET['q'])) . '%';
            $where[] = '(quote_no LIKE ? OR title LIKE ? OR client_json LIKE ?)';
            array_push($p, $like, $like, $like);
        }
        $sql = 'SELECT id,quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,subtotal,discount,tax,round_off,total,created_at,updated_at FROM quotes'
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT 500';
        json_out(array_map(fn($r) => quote_row_out($r, false), q($sql, $p)->fetchAll()));
    }

    if ($m === 'POST' && $b === null) {
        [$division, $title, $data, $client, $date, $valid, $cid] = clean_quote_input(body());
        [$cid, $client] = resolve_client($cid, $client);
        [$sub, $disc, $tax, $round, $total] = compute_totals($data);
        $no = next_quote_no($division, $date);
        q('INSERT INTO quotes (quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,data,subtotal,discount,tax,round_off,total,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [$no, 0, 1, $division, $cid, json_encode($client, JSON_UNESCAPED_UNICODE), $title, 'draft', $date, $valid, json_encode($data, JSON_UNESCAPED_UNICODE), $sub, $disc, $tax, $round, $total, $user['id'], now(), now()]);
        json_out(['id' => (int)db()->lastInsertId(), 'quote_no' => $no], 201);
    }

    if ($b === null || !ctype_digit($b)) fail('Not found', 404);
    $id = (int)$b;
    $row = q('SELECT * FROM quotes WHERE id = ?', [$id])->fetch();
    if (!$row) fail('Quote not found', 404);

    if ($m === 'GET' && $c === null) {
        $revs = q('SELECT id,rev,status,total,updated_at FROM quotes WHERE quote_no = ? ORDER BY rev DESC', [$row['quote_no']])->fetchAll();
        json_out(['quote' => quote_row_out($row, true), 'revisions' => $revs]);
    }

    if ($m === 'PUT' && $c === null) {
        if ($row['status'] === 'superseded') fail('This revision is superseded and read-only. Open the latest revision.');
        [$division, $title, $data, $client, $date, $valid, $cid] = clean_quote_input(body(), $row['division']);
        [$cid, $client] = resolve_client($cid, $client);
        [$sub, $disc, $tax, $round, $total] = compute_totals($data);
        q('UPDATE quotes SET client_id=?,client_json=?,title=?,quote_date=?,valid_until=?,data=?,subtotal=?,discount=?,tax=?,round_off=?,total=?,updated_at=? WHERE id=?',
            [$cid, json_encode($client, JSON_UNESCAPED_UNICODE), $title, $date, $valid, json_encode($data, JSON_UNESCAPED_UNICODE), $sub, $disc, $tax, $round, $total, now(), $id]);
        json_out(['ok' => true, 'total' => $total, 'client_id' => $cid]);
    }

    if ($m === 'POST' && $c === 'status') {
        $s = (string)(body()['status'] ?? '');
        if (!in_array($s, ['draft', 'sent', 'accepted', 'rejected'], true)) fail('Invalid status');
        if ($row['status'] === 'superseded') fail('Superseded revisions cannot change status');
        q('UPDATE quotes SET status=?, updated_at=? WHERE id=?', [$s, now(), $id]);
        json_out(['ok' => true]);
    }

    if ($m === 'POST' && $c === 'revise') {
        if (!(int)$row['is_latest']) fail('Only the latest revision can be revised');
        $newRev = (int)$row['rev'] + 1;
        db()->beginTransaction();
        q('UPDATE quotes SET is_latest = 0, status = ?, updated_at = ? WHERE id = ?', ['superseded', now(), $id]);
        q('INSERT INTO quotes (quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,data,subtotal,discount,tax,round_off,total,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [$row['quote_no'], $newRev, 1, $row['division'], $row['client_id'], $row['client_json'], $row['title'], 'draft', date('Y-m-d'),
                date('Y-m-d', strtotime('+' . (int)(get_setting('validity_days') ?: 15) . ' days')), $row['data'], $row['subtotal'], $row['discount'], $row['tax'], $row['round_off'], $row['total'], $user['id'], now(), now()]);
        $newId = (int)db()->lastInsertId();
        db()->commit();
        json_out(['id' => $newId, 'rev' => $newRev], 201);
    }

    if ($m === 'POST' && $c === 'duplicate') {
        $today = date('Y-m-d');
        $no = next_quote_no($row['division'], $today);
        q('INSERT INTO quotes (quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,data,subtotal,discount,tax,round_off,total,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [$no, 0, 1, $row['division'], $row['client_id'], $row['client_json'], $row['title'], 'draft', $today,
                date('Y-m-d', strtotime('+' . (int)(get_setting('validity_days') ?: 15) . ' days')), $row['data'], $row['subtotal'], $row['discount'], $row['tax'], $row['round_off'], $row['total'], $user['id'], now(), now()]);
        json_out(['id' => (int)db()->lastInsertId(), 'quote_no' => $no], 201);
    }

    if ($m === 'DELETE' && $c === null) {
        // Delete the whole quote family (all revisions) only when it is still a draft.
        if ($row['status'] !== 'draft' && !(int)$row['is_latest']) fail('Open the latest revision to delete');
        if ($row['status'] !== 'draft') fail('Only draft quotes can be deleted');
        q('DELETE FROM quotes WHERE quote_no = ?', [$row['quote_no']]);
        json_out(['ok' => true]);
    }
    fail('Not found', 404);
}

// ---------------- dashboard ----------------
function dashboard(): array
{
    $byStatus = q("SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE is_latest = 1 GROUP BY status")->fetchAll();
    $byDiv = q("SELECT division, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE is_latest = 1 GROUP BY division")->fetchAll();
    $since = date('Y-m-01', strtotime('-5 months'));
    $monthly = q("SELECT substr(quote_date,1,7) AS month, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE is_latest = 1 AND quote_date >= ? GROUP BY substr(quote_date,1,7) ORDER BY month", [$since])->fetchAll();
    $recent = q('SELECT id,quote_no,rev,division,client_json,title,status,quote_date,total FROM quotes WHERE is_latest = 1 ORDER BY id DESC LIMIT 8')->fetchAll();
    $cast = function (array $rows) {
        foreach ($rows as &$r) {
            if (isset($r['n'])) $r['n'] = (int)$r['n'];
            if (isset($r['value'])) $r['value'] = (float)$r['value'];
        }
        return $rows;
    };
    return [
        'by_status' => $cast($byStatus), 'by_division' => $cast($byDiv), 'monthly' => $cast($monthly),
        'recent' => array_map(fn($r) => quote_row_out($r + ['subtotal' => 0, 'discount' => 0, 'tax' => 0, 'round_off' => 0], false), $recent),
        'clients' => (int)q('SELECT COUNT(*) AS n FROM clients')->fetch()['n'],
    ];
}
