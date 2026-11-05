<?php
// Test helper: bulk-load N quotes (+ clients, events, projects) straight into the DB to measure performance.
// php tests/seed_bulk.php <app-dir> <count>
$dir = $argv[1]; $n = (int)($argv[2] ?? 5000);
$cfg = require $dir . '/api/config.php';
$pdo = ($cfg['driver'] ?? 'mysql') === 'sqlite' ? new PDO('sqlite:' . $cfg['sqlite_path']) : new PDO('mysql:host=' . $cfg['host'] . ';dbname=' . $cfg['name'] . ';charset=utf8mb4', $cfg['user'], $cfg['pass']);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
mt_srand(7); $divs = ['roofing', 'interior', 'construction', 'pmc']; $codes = ['roofing' => 'RF', 'interior' => 'IN', 'construction' => 'CN', 'pmc' => 'PM']; $st = ['draft', 'sent', 'accepted', 'rejected'];
$pdo->beginTransaction();
$insC = $pdo->prepare('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)');
$insQ = $pdo->prepare('INSERT INTO quotes (quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,data,subtotal,discount,tax,round_off,total,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
$insE = $pdo->prepare('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)');
$clients = (int)($n / 2);
for ($i = 1; $i <= $clients; $i++) $insC->execute(["Client $i Pvt Ltd", "Person $i", '98' . str_pad((string)$i, 8, '0', STR_PAD_LEFT), "c$i@example.com", "$i Industrial Estate", '', date('Y-m-d H:i:s')]);
for ($i = 1; $i <= $n; $i++) {
    $d = $divs[$i % 4]; $s = $st[mt_rand(0, 3)]; $cid = mt_rand(1, $clients); $items = [];
    for ($k = 0; $k < 12; $k++) $items[] = ['desc' => "Line item $k for quote $i - supply and fixing of material", 'unit' => 'sq ft', 'qty' => mt_rand(10, 5000), 'rate' => mt_rand(50, 900), 'cost' => mt_rand(40, 700), 'note' => ''];
    $data = ['sections' => [['title' => 'Works', 'items' => $items, 'images' => []]], 'options' => [], 'selected_option' => 0, 'discount' => ['type' => 'percent', 'value' => 0], 'tax_rate' => 18, 'round_off' => false,
        'payment_schedule' => [['label' => 'Advance', 'percent' => 50], ['label' => 'Balance', 'percent' => 50]], 'terms' => ['t1', 't2', 't3'], 'notes' => '', 'scope' => 'Scope', 'site_address' => 'Site', 'area_sqft' => 1000, 'source' => ['Referral', 'Website', 'WhatsApp'][$i % 3], 'lang' => ''];
    $sub = 0; foreach ($items as $it) $sub += $it['qty'] * $it['rate']; $tax = round($sub * .18, 2);
    $date = date('Y-m-d', strtotime('-' . mt_rand(0, 700) . ' days')); $no = "INF/{$codes[$d]}/" . ($i % 3 ? '25-26' : '26-27') . '/' . str_pad((string)$i, 5, '0', STR_PAD_LEFT);
    $insQ->execute([$no, 0, 1, $d, $cid, json_encode(['name' => "Client $cid Pvt Ltd", 'phone' => '98' . str_pad((string)$cid, 8, '0', STR_PAD_LEFT)]), "Project $i", $s, $date, date('Y-m-d', strtotime($date . ' +15 days')), json_encode($data), $sub, 0, $tax, 0, $sub + $tax, 1, $date . ' 10:00:00', $date . ' 10:00:00']);
    if ($i % 2) $insE->execute([$no, 0, 'view', '{}', null, '1.2.3.4', $date . ' 11:00:00']);
}
$pdo->commit();
echo "seeded $n quotes, $clients clients\n";
