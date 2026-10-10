# 停止 ModelMonitor 的 dev 进程链（只动本项目：3000 / 22555）
$ErrorActionPreference = "SilentlyContinue"

function Stop-ProjectChain($port) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -First 1
  if (-not $conn) { Write-Output ("port ${port}: not listening"); return }
  $pids = @()
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
  $depth = 0
  while ($cur -and $depth -lt 8) {
    $name = $cur.Name
    $cmd = $cur.CommandLine
    # 沿父链收集 node/npm 以便整树结束；遇到不属于本项目的命令行就停（防误伤其他项目）
    if ($name -match '^(node|npm)\.exe$' -or ($name -match '^cmd\.exe$' -and $cmd -match 'npm run dev|dev-server')) {
      $pids += $cur.ProcessId
    } else {
      Write-Output ("port ${port}: stop at non-project process PID=$($cur.ProcessId) name=$name")
      break
    }
    $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)"
    $depth++
  }
  foreach ($id in ($pids | Select-Object -Unique)) {
    & taskkill /PID $id /T /F 2>$null
  }
  Write-Output ("port ${port}: killed chain [{0}]" -f ($pids -join ','))
}

Stop-ProjectChain 22555
Start-Sleep -Milliseconds 500
Stop-ProjectChain 3000
Start-Sleep -Milliseconds 800

# 复核端口状态
foreach ($port in 22555, 3000) {
  $still = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  Write-Output ("port ${port} still listening: {0}" -f [bool]$still)
}