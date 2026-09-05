# ADR-051 — Assinaturas binárias mínimas de media

## Estado

Aceite em 2026-09-05.

## Decisão

O `MediaIngestor` não confia apenas no MIME enviado pelo webhook nem no `Content-Type` devolvido pelo provider. Antes do storage, valida uma assinatura binária mínima e determinística para cada formato permitido:

- JPEG: `FF D8 FF`;
- PNG: assinatura completa de oito bytes;
- PDF: `%PDF-` no início;
- OGG: `OggS`;
- MP3: `ID3` ou sync word MPEG;
- MP4: box `ftyp` e major brand ASCII.

O tipo declarado, o tipo recebido e a assinatura têm de concordar. Tipo desconhecido, conteúdo demasiado curto ou assinatura divergente falham antes de `StorageProvider.put`; os bytes não são persistidos e a falha entra no ciclo limitado de retries existente.

## Limites

Magic bytes reduzem spoofing trivial, mas não demonstram que o ficheiro é íntegro ou seguro. Parsing estrutural completo, deteção de polyglots, malware scanning e descompressão segura continuam obrigatórios antes de tornar anexos acessíveis a utilizadores ou IA.
