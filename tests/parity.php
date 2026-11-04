<?php
// Reads cases from argv[1] (JSON), prints compute_totals() for each. Used by tests/parity.js
require __DIR__ . '/../api/lib.php';
$cases = json_decode(file_get_contents($argv[1]), true);
$out = [];
foreach ($cases as $d) { [$sub, $disc, $tax, $ro, $total] = compute_totals($d); $out[] = [$sub, $disc, $tax, $ro, $total]; }
echo json_encode($out);
