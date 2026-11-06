#!/bin/zsh
# Gera um .zip da Bancada para passar para outra pessoa (Mac com chip Apple).
# Uso: npm run share  →  dist-share/Bancada-<versão>-mac-arm64.zip
# Sem conta de desenvolvedor Apple, o app vai com assinatura local (ad-hoc): no 1º uso a pessoa abre em
# Ajustes do Sistema → Privacidade e Segurança → "Abrir Mesmo Assim" (passo a passo em docs/PASSAR-A-BANCADA.md).
# Nada pessoal vai junto: dados, notas, projetos e contas ficam na pasta de dados de cada Mac, fora do app.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
node scripts/vendor.js >/dev/null
rm -rf dist dist-share
npx electron-builder --mac dir --arm64 >/dev/null
# assina uma cópia limpa FORA de Documentos (o iCloud põe atributos que o codesign recusa)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ditto --norsrc --noextattr --noqtn dist/mac-arm64/Bancada.app "$TMP/Bancada.app"
xattr -cr "$TMP/Bancada.app"
codesign --force --deep --sign - "$TMP/Bancada.app"
codesign --verify --deep --strict "$TMP/Bancada.app"
mkdir -p dist-share
ditto -c -k --norsrc --noextattr --keepParent "$TMP/Bancada.app" "dist-share/Bancada-$VER-mac-arm64.zip"
rm -rf dist
echo "Pronto: dist-share/Bancada-$VER-mac-arm64.zip ($(du -h "dist-share/Bancada-$VER-mac-arm64.zip" | cut -f1))"
