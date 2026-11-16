# Motor de voz (whisper.cpp) embutido na Bancada

A Bancada transforma fala em texto **no próprio computador** com o `whisper-cli` do
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT). O binário vai dentro do app
(`Resources/whisper/`); o modelo (≈ 550 MB) é baixado sob demanda pela própria Bancada, do Hugging Face oficial,
com SHA-256 fixo no código (`app/main/voice.js`).

## Mac — `mac/whisper-cli` (NÃO versionado; compilado da fonte no build)

Nenhum binário pronto vai no repositório: o `npm run dist:mac` (ou só `npm run whisper:mac`) roda
`scripts/build-whisper-mac.js`, que **compila o whisper.cpp a partir do código-fonte oficial**:

- fonte: tag **v1.9.5** — `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz`
- SHA-256 do tarball (conferido antes de abrir): `ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720`
- resultado: universal (arm64 + x86_64), estático, só depende de frameworks do sistema (Accelerate, Metal, Foundation,
  libc++) — o script confere com `lipo -archs` e `otool -L` e grava o carimbo `mac/FONTE.txt`.
- já compilado com a mesma fonte? não refaz (forçar: `node scripts/build-whisper-mac.js --force`).

Precisa de Xcode Command Line Tools e cmake (`brew install cmake`); ~45 s num M1 Pro. O que o script faz, à mão:

```sh
curl -LO https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz
shasum -a 256 v1.9.5.tar.gz   # ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720
tar xzf v1.9.5.tar.gz
cmake -S whisper.cpp-1.9.5 -B build-u -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
cmake --build build-u -j 6 --target whisper-cli
cp build-u/bin/whisper-cli build/whisper/mac/whisper-cli
lipo -archs build/whisper/mac/whisper-cli   # x86_64 arm64
```

O hash do binário pode variar entre máquinas (caminho/data de compilação); o que se audita é a fonte (tag + SHA-256)
e este procedimento. O `dist:mac` assina o binário com a mesma identidade do app.

## Windows — `win/` (NÃO versionado; gerado no build)

`npm run dist:win` roda `scripts/fetch-whisper-win.js`: baixa o zip oficial
`https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip`, confere o SHA-256
`6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb` e copia só `whisper-cli.exe`, `whisper.dll`,
`ggml.dll`, `ggml-base.dll` e os `ggml-cpu-*.dll` (≈ 11 MB), com o SHA-256 de cada um em `win/MANIFEST.sha256`.
Esses arquivos precisam do runtime do Visual C++ (x64) no Windows — a Checagem da Bancada confere e mostra o link oficial.

## Primeiro uso

A 1ª execução de cada binário novo compila os shaders do Metal (7–8 s no Mac). A Bancada faz isso em 2º plano
("aquecimento", 1 s de silêncio) logo depois de baixar o modelo e depois de cada atualização — nunca na 1ª fala.
