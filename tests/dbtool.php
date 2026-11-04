<?php
// Test helper: run one SQL statement against an app directory's database.  php tests/dbtool.php <app-dir> "<sql>" ['<json params>']
$dir = $argv[1] ?? ''; $sql = $argv[2] ?? ''; $params = json_decode($argv[3] ?? '[]', true) ?: [];
$cfg = require $dir . '/api/config.php';
$pdo = ($cfg['driver'] ?? 'mysql') === 'sqlite' ? new PDO('sqlite:' . $cfg['sqlite_path']) : new PDO('mysql:host=' . $cfg['host'] . ';dbname=' . $cfg['name'] . ';charset=utf8mb4', $cfg['user'], $cfg['pass']);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$st = $pdo->prepare($sql); $st->execute($params);
echo json_encode(stripos(ltrim($sql), 'select') === 0 ? $st->fetchAll(PDO::FETCH_ASSOC) : ['rows' => $st->rowCount()]);
