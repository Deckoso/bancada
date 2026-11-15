#!/bin/zsh
# Atualiza a Bancada SEM precisar de Terminal fora dela: monta a versão nova agora (com a Bancada aberta),
# fica esperando você sair da Bancada (Bancada → Sair), troca o app em /Applications e abre a nova.
# Uso: npm run update-app   (pode rodar de dentro de um terminal da própria Bancada)
# Espera no máximo 2 h; depois desiste sem mexer em nada. Log: ~/Library/Logs/Bancada-update.log
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="/Applications/Bancada.app"
STAGE="$HOME/Library/Caches/Bancada-update"
LOG="$HOME/Library/Logs/Bancada-update.log"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

echo "Montando a versão nova (a Bancada pode continuar aberta)…"
node scripts/vendor.js >/dev/null
rm -rf dist dist-next
npx electron-builder --mac dir --arm64 >/dev/null
for old in dist/mac-arm64/Bancada.app; do [ -d "$old" ] && $LSREG -u "$PWD/$old" 2>/dev/null || true; done
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto --norsrc --noextattr --noqtn dist/mac-arm64/Bancada.app "$STAGE/Bancada.app"
rm -rf dist dist-next
xattr -cr "$STAGE/Bancada.app"
codesign --force --deep --sign - "$STAGE/Bancada.app"
codesign --verify --deep --strict "$STAGE/Bancada.app"
VER=$(defaults read "$STAGE/Bancada.app/Contents/Info.plist" CFBundleShortVersionString)

# troca em segundo plano, fora da árvore de processos da Bancada (sobrevive ao fechar)
cat > "$STAGE/swap.sh" <<EOF
#!/bin/zsh
exec >>"$LOG" 2>&1
echo "[\$(date)] esperando a Bancada fechar para instalar $VER"
for i in {1..1440}; do
  pgrep -f "Bancada.app/Contents/MacOS/Bancada" >/dev/null || break
  sleep 5
done
if pgrep -f "Bancada.app/Contents/MacOS/Bancada" >/dev/null; then echo "desisti: a Bancada ficou aberta 2 h"; exit 0; fi
sleep 1
rm -rf "$APP"
ditto "$STAGE/Bancada.app" "$APP"
codesign --verify --deep --strict "$APP"
$LSREG -f "$APP"
rm -rf "$STAGE"
echo "[\$(date)] instalada $VER"
open "$APP"
EOF
chmod +x "$STAGE/swap.sh"
# sessão própria (setsid) + nohup: fechar o terminal/Bancada não derruba a troca
nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/zsh "$STAGE/swap.sh" </dev/null >/dev/null 2>&1 &!
echo "Pronta: Bancada $VER montada. Agora é só sair da Bancada (Bancada → Sair ou ⌘Q): ela troca sozinha e reabre já atualizada."
