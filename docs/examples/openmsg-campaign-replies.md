# Respostas de campanhas do OpenMsg no n8n

Este guia descreve o rascunho de atendimento de campanhas do fork OpenMsg. A integração usa os nós nativos
**Webhook**, **Crypto**, **Data table** e **HTTP Request** do n8n. O cadastro do webhook no OpenMsg é separado
da publicação do workflow; o rascunho não usa o trigger comunitário que cria webhooks automaticamente.

Consulte também [OpenMsg: campanhas](../../OPENMSG.md#campanhas),
[API: campanhas](../06-api-specification.md#6418-campaigns-openmsg) e
[integração n8n do upstream](../22-n8n-integration.md).

## Objetivo e estado verificado

O atendimento será de cobrança de inadimplência com IA no n8n. A conversa deve começar por uma resposta de
campanha e continuar nas mensagens seguintes desse cliente. O Hermes não participa. As respostas devem usar
um modelo de mensagem cadastrado no OpenMsg; o modelo de IA do n8n é uma configuração diferente.

Estado verificado em **08/10/2026**:

| Item                     | Estado                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Workflow                 | `OpenMsg - respostas de campanhas - rascunho`, ID `1iib7YO4tWbIiY4y`; inativo                         |
| Atendimento e envios     | Desativados por `atendimentoEnabled: false`; regras de cobrança pendentes                             |
| Sessão                   | `douglas-teste`, com status `ready` durante a consulta                                                |
| Modelos de mensagem      | A consulta de modelos da sessão retornou uma lista vazia                                              |
| Credencial de API        | `OpenMsg n8n operator`, tipo Header Auth; consulta autenticada de sessões e modelos retornou HTTP 200 |
| Credencial de assinatura | `OpenMsg webhook HMAC`, tipo Crypto; vinculada ao nó HMAC e testada com uma assinatura inválida       |
| Nó de IA                 | OpenAI Chat Model; atendimento com IA ainda não testado                                               |
| Webhook da sessão        | Ainda não cadastrado por esta integração                                                              |
| Endereço público do n8n  | Ainda precisa ser confirmado antes do cadastro do webhook                                             |
| Teste real pelo WhatsApp | Pendente; o fluxo não enviou mensagens                                                                |

Esses resultados registram a preparação da integração. Uma sessão pode desconectar e configurações podem
mudar; confira novamente o estado antes de ativar. A leitura com a credencial operator valida a chave, mas
não comprova a seleção dessa credencial no nó de envio nem um envio bem-sucedido.

## Configurar as credenciais

### API do OpenMsg: Header Auth

1. No OpenMsg, abra **Chaves API** e crie uma chave exclusiva para o n8n com papel **operator**.
2. No n8n, abra o nó **Enviar modelo pelo OpenMsg** do rascunho.
3. Em **Authentication**, selecione **Generic Credential Type**; em **Generic Auth Type**, selecione **Header Auth**.
4. Em **Credential for Header Auth**, escolha **Create New** ou selecione a credencial existente.
5. Defina o nome da credencial como `OpenMsg n8n operator`, o campo **Name** como `X-API-Key` e o campo **Value**
   como a chave exclusiva. Cole somente a chave, sem prefixo `Bearer`.
6. Salve e confira que a credencial ficou selecionada no nó.

O nome da credencial é o título editável no topo da janela, separado do campo **Name** do cabeçalho.
O MCP permitiu listar e validar a credencial em uma consulta temporária, mas recusou a operação
`setNodeCredential` para Header Auth no nó HTTP. Confira a seleção pela interface do n8n.

### Assinatura do webhook: Crypto

1. Abra o nó **Calcular HMAC SHA256**.
2. No campo de credencial **Crypto**, selecione **Create New** ou escolha a credencial existente.
3. Defina o nome como `OpenMsg webhook HMAC`. Se o título não permitir edição, o nome padrão **Crypto account**
   também funciona: selecione essa credencial no nó.
4. Preencha somente **Hmac Secret** com um segredo aleatório novo, gerado por um gerenciador de senhas.
5. Deixe os campos de chave privada e criptografia vazios; salve a credencial.

Use exatamente o mesmo segredo no campo `secret` ao cadastrar o webhook no OpenMsg. Esse segredo é diferente
da chave API operator. Não coloque valores secretos no JSON do workflow, no repositório, em logs ou no chat.

O nó Webhook recebe o **Raw Body** em binário. O nó Crypto calcula HMAC-SHA256 sobre esses bytes, com saída
hexadecimal, e o nó seguinte compara o resultado com `X-OpenWA-Signature: sha256=<hex>` antes de interpretar
o JSON. Recriar o corpo com `JSON.stringify()` não substitui a verificação do corpo bruto.

## Caminho das mensagens

1. **OpenMsg message.received** recebe um POST no caminho `openmsg-campaign-replies`.
2. **Calcular HMAC SHA256** e **Verificar assinatura e interpretar** conferem a assinatura e o corpo.
   Assinatura inválida retorna 401; corpo inválido retorna 400. Falha no serviço de assinatura retorna 503.
3. O fluxo descarta outros eventos, mensagens próprias, grupos e mensagens cujo `kind` não é `individual`.
   Mensagens descartadas recebem 200, para encerrar a entrega sem novas tentativas.
4. **Buscar conversa de campanha** consulta o vínculo por sessão e `chatId`. Quando `data.campaign` existe,
   **Vincular conversa a campanha** usa seus dados. Quando não existe, exige um vínculo com status `active`.
5. **Guardar vinculo da campanha** mantém a origem na tabela `OpenMsg campaign conversations`.
6. **Buscar idempotency key** consulta `OpenMsg campaign inbox` usando `X-OpenWA-Idempotency-Key`.
   Uma repetição já registrada recebe 200. Um evento novo é gravado com status `awaiting_config` antes do ACK 202.
7. **Configurar atendimento futuro** mantém `atendimentoEnabled: false`, `templateId` vazio e `variables` vazio.
   O fluxo para antes da IA e do envio.

O vínculo persiste no n8n porque `data.campaign` aparece somente na primeira resposta. Mensagens sem vínculo
com campanha não iniciam atendimento. Preserve o `chatId` recebido, incluindo os sufixos `@c.us`,
`@s.whatsapp.net` ou `@lid`; não o reconstrua a partir de um telefone.

As tabelas pertencem ao n8n, não ao banco do OpenMsg. O histórico em **Conversas** é o registro inicial pretendido
no gateway. Etiquetas, CRM e outros registros ainda não foram definidos. Nenhuma tabela do OpenMsg foi alterada
por esta preparação.

## Configurar o atendimento e o modelo de mensagem

Antes de habilitar o atendimento, defina as fontes dos dados de cobrança, regras de negociação, encaminhamento
para uma pessoa e critérios de encerramento. O rascunho não consulta dados financeiros nem oferece acordos.

Crie um modelo de mensagem na sessão do OpenMsg e consulte seu ID em
`GET /api/sessions/{sessionId}/templates`. Em **Configurar atendimento futuro**, preencha `templateId` e mapeie
`variables` somente para os placeholders reais do modelo. A saída da IA ainda não alimenta essas variáveis;
esse mapeamento depende do modelo e das regras aprovadas.

**Preparar envio do modelo** monta o pedido para `POST /api/sessions/{sessionId}/messages/send-template`.
O nó de envio usa a credencial operator e uma `Idempotency-Key` derivada do evento recebido. O OpenMsg renderiza
o cabeçalho, corpo e rodapé do modelo como texto, substituindo seus placeholders `{{variavel}}`.

**Tratar envio 429 e 409** grava `retry_pending`, o pedido de envio e `nextAttemptAt` quando o envio é limitado
ou a sessão não está pronta. O rascunho não repete imediatamente, mas ainda não tem um worker que retome esses
pedidos. Também falta recuperar falhas de rede após o ACK. Ao retomar, preserve o corpo e a chave do pedido,
respeite `retryAfterSeconds` e considere a janela de idempotência do gateway.

## Testes realizados

- O código do rascunho inicial passou pela validação do SDK do n8n.
- Quatro execuções simuladas no n8n passaram: primeira resposta de campanha, evento repetido, continuação sem
  `campaign` e conversa sem vínculo. HMAC e tabelas foram simulados nesses quatro testes; IA e envio não rodaram.
- Dezessete verificações locais passaram para comparação de assinatura, filtros, vínculo, preservação de `chatId`,
  bloqueio do atendimento e classificação de 429/409.
- Um teste posterior executou o nó Crypto com a credencial HMAC real e rejeitou uma assinatura fictícia inválida
  com 401. Isso não comprova a aceitação de uma entrega assinada pelo OpenMsg.
- Consultas reais de sessões e modelos com a credencial operator retornaram HTTP 200. O workflow temporário
  dessas consultas foi arquivado.

A persistência real, entregas simultâneas, recuperação após falha, IA, envio de modelos e o caminho completo
pelo WhatsApp ainda precisam de testes. Os dados fictícios dos testes não ficaram fixados no rascunho.

## Antes de ativar

1. Confirme a credencial operator no nó de envio, escolha o modelo de mensagem e configure o atendimento.
2. Garanta deduplicação atômica por evento: consultar e depois inserir em Data Tables não garante unicidade
   quando duas entregas chegam simultaneamente. Resolva também a concorrência das mensagens da mesma conversa.
3. Implemente a retomada persistente dos envios pendentes e a recuperação de falhas após o ACK, mantendo o
   pedido original. Defina encerramento dos vínculos e retenção dos dados; a memória simples da IA é temporária.
4. Confirme o endereço público HTTPS do n8n e a URL de produção do nó Webhook. `0.0.0.0` é um endereço de escuta,
   não uma URL pública de callback. O MCP é uma interface de gestão, não o endpoint que recebe mensagens.
5. Teste persistência, concorrência, assinatura válida e inválida, falhas de rede e respostas 429/409 sem disparar
   mensagens para clientes.
6. Apresente a URL, sessão, evento `message.received` e uso do segredo antes de cadastrar o webhook. Aguarde a
   autorização de produção; mudanças de rede ou `.env` também exigem autorização específica.
7. Após autorização, publique o workflow, cadastre a URL de produção no OpenMsg e execute uma campanha pequena
   para um número próprio. Confira a primeira resposta com `campaign` e a continuidade sem esse campo.

Não use a URL de teste do n8n no cadastro permanente. Uma URL interna como `http://n8n:5678/...` exige rede Docker
compartilhada e permissão em `SSRF_ALLOWED_HOSTS`; não altere essas configurações nem outros serviços da VM
como parte de uma atualização de documentação.

Alterações apenas neste guia não exigem deploy do OpenMsg nem ativação do workflow no n8n.
