# ADR-049 — Storage persistente S3-compatible

## Estado

Aceite em 2026-09-05.

## Decisão

Adicionar um `S3StorageProvider` privado, desligado por defeito e criado apenas quando `STORAGE_PROVIDER=s3` possui endpoint HTTPS, região, bucket e credenciais server-side completos. O adapter usa AWS Signature Version 4 e suporta credenciais temporárias por session token.

As chaves permanecem opacas e tenant-scoped. `PUT` usa `If-None-Match: *`; um conflito só é considerado replay quando tipo, tamanho e checksum persistido coincidem. Conteúdo divergente nunca sobrescreve o objeto existente. `GET` é streaming limitado e confirma tamanho/checksum antes de devolver bytes. Redirects, HTTP, userinfo, paths de endpoint e portas não TLS são recusados.

O checksum Melissa cobre MIME e bytes, sendo guardado como metadata privada do objeto. Não são criadas URLs públicas ou presigned URLs. Erros não incluem endpoint, chave, token, assinatura ou respostas do provider.

## Limites

- A compatibilidade foi testada contra um transporte S3 injetado, não contra uma conta/cloud real.
- Lifecycle, versioning, encryption-at-rest, bucket policy, replication e retenção são configuração operacional externa e ainda precisam de validação por ambiente.
- O factory não cai para mock. O worker de ingestão permanece desligado até existir um teste integrado de recuperação com o provider configurado.
