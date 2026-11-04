<?php
// Reads cases (argv[1]); prints roof_calc() totals for each. Used by tests/roof_parity.js
require __DIR__ . '/../api/core.php';
$cases = json_decode(file_get_contents($argv[1]), true);
$out = [];
foreach ($cases as $c) {
    $r = roof_calc($c['in'], array_keys(ROOF_MATS), $c['rates']);
    if (!$r) { $out[] = null; continue; }
    $row = [];
    foreach ($r['packages'] as $p) $row[$p['material']] = [$p['total_before_gst'], count($p['lines']), money(array_sum(array_map(fn($l) => $l['qty'] * $l['cost'], $p['lines'])))];
    $out[] = $row;
}
echo json_encode($out);
