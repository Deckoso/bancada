#!/bin/zsh
# Instala UMA Bancada em /Applications e não deixa cópia de build solta (o macOS listava duas).
# Uso: npm run install-app
set -euo pipefail
cd "$(dirname "$0")/.."
APP="/Applications/Bancada.app"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if pgrep -f "Bancada.app/Contents/MacOS/Bancada" >/dev/null; then
  echo "A Bancada está aberta. Feche (Bancada → Sair) e rode de novo."; exit 1
fi
node scripts/vendor.js >/dev/null
rm -rf dist dist-next
npx electron-builder --mac dir --arm64 >/dev/null
# tira as cópias antigas do registro do macOS (Launchpad/Spotlight/Abrir com)
for old in dist/mac-arm64/Bancada.app dist-next/mac-arm64/Bancada.app; do [ -d "$old" ] && $LSREG -u "$PWD/$old" 2>/dev/null || true; done
rm -rf "$APP"
# cópia sem os atributos do iCloud (Documentos sincroniza) e assinatura local (ad-hoc, sem conta Apple):
# sem isso o selo fica quebrado e o macOS chama o app de "danificado"
ditto --norsrc --noextattr --noqtn dist/mac-arm64/Bancada.app "$APP"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
rm -rf dist dist-next
$LSREG -f "$APP"
echo "Instalada: $APP"
