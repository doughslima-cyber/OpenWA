# OpenMsg

O OpenMsg é um fork do [OpenWA](https://github.com/rmyndharis/OpenWA), um gateway de API para WhatsApp de código
aberto (licença MIT). O fork mantém o gateway do projeto original e acrescenta três coisas: uma marca própria, o
login no painel por e-mail e senha, com gestão de usuários, e as campanhas de disparo espaçado para uma lista de
números.

Este documento explica o que muda em relação ao OpenWA, como funcionam usuários, senhas e campanhas, como o OpenMsg
está implantado e como trazer as atualizações do projeto original.

## O que muda em relação ao OpenWA

| Área             | No OpenWA                               | No OpenMsg                                                                       |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Marca do painel  | Logo, nome e verde do OpenWA            | Logo OpenMsg (anel índigo), nome OpenMsg, paleta índigo                          |
| Login do painel  | Cola-se uma API key                     | E-mail e senha; a API key não abre mais o painel                                 |
| Pessoas          | Não existe o conceito de usuário        | Página **Usuários** (só admin) e página **Minha conta** (todos)                  |
| Senhas           | Não se aplica                           | Senha provisória obrigatória de trocar, troca da própria senha, recuperação      |
| API e integração | API keys com papel (admin/operador/...) | Iguais: as API keys continuam sendo a credencial do n8n, do Hermes e de scripts  |
| Disparo em massa | Lote de até 100 números, tudo na hora   | Página **Campanhas**: até 5 000 números, no ritmo do anti-banimento, por dias    |
| Webhook          | `message.received` traz a mensagem      | Igual, e a primeira resposta a uma campanha traz também `campaign: { id, name }` |

A API, os motores (Baileys e whatsapp-web.js), os plugins e o resto do gateway não mudam; dos webhooks, só o
`message.received` ganha um campo opcional.

## Papéis

Cada usuário tem um papel. O papel vale para tudo o que a pessoa faz no painel, porque cada login gera uma chave
com esse papel e o backend confere o papel em cada rota.

| Pode...                                                                                                            | Visualizador | Operador | Admin |
| ------------------------------------------------------------------------------------------------------------------ | :----------: | :------: | :---: |
| Ver sessões, conversas, contatos, grupos, mensagens e campanhas                                                    |      ✓       |    ✓     |   ✓   |
| Enviar mensagens, criar e parear sessões, mexer em grupos, etiquetas, status e modelos; criar e cancelar campanhas |              |    ✓     |   ✓   |
| Configurar webhooks da sessão e regras de automação                                                                |              |    ✓     |   ✓   |
| Chaves API, Usuários, Infraestrutura, Plugins, Registros, configurações e estatísticas                             |              |          |   ✓   |
| Trocar a própria senha em **Minha conta**                                                                          |      ✓       |    ✓     |   ✓   |

Não é preciso criar uma API key para cada pessoa: o login cria a chave sozinho. A página **Chaves API** fica para
as integrações, cada uma com o menor papel de que precisa.

## Usuários e senhas

### Cadastro de um usuário

1. Um admin abre **Usuários → Adicionar usuário** e informa nome, e-mail, papel e uma **senha provisória** (mínimo
   de 10 caracteres).
2. O admin passa a senha provisória para a pessoa por um canal à parte. O OpenMsg não envia e-mail.
3. No primeiro acesso, o painel pede que a pessoa defina a própria senha. Enquanto ela não fizer isso, o servidor
   não gera chave nenhuma, então a senha provisória não dá acesso a nada além dessa troca.

Na lista de usuários, quem ainda não trocou a senha aparece com o selo **senha provisória**.

### Esqueci a senha

- **Um usuário comum:** um admin edita o usuário e digita uma senha nova. Ela volta a ser provisória, e as sessões
  abertas da pessoa caem na hora.
- **Um admin, com outro admin disponível:** o mesmo procedimento, feito pelo outro admin.
- **Nenhum admin consegue entrar:** a recuperação é pela VM, com `ADMIN_PASSWORD_RESET`. O passo a passo está em
  [Runbook: Dashboard Password Recovery](docs/11-operational-runbooks.md#runbook-dashboard-password-recovery).

### Minha conta

Qualquer usuário troca a própria senha em **Minha conta**, informando a senha atual. A troca encerra as outras
sessões da pessoa e mantém a atual. Cinco tentativas erradas da senha atual bloqueiam a troca por 15 minutos.

### Regras de segurança

- As senhas são guardadas como hash scrypt, nunca em texto puro.
- A sessão do painel acaba ao fechar a aba. No servidor, a chave do login expira em até 7 dias.
- Cinco tentativas erradas por e-mail, ou 20 por IP, bloqueiam o login por 15 minutos.
- Mudar o papel de alguém, desativar, redefinir a senha ou excluir encerra as sessões abertas dessa pessoa.
- Ninguém consegue remover o próprio acesso de admin, e sempre sobra pelo menos um admin ativo.

Os detalhes técnicos estão em [docs/04 §4.2, Dashboard Sign-in](docs/04-security-design.md#dashboard-sign-in), e as
rotas (`/api/auth/login`, `/api/auth/logout`, `/api/auth/me/password`, `/api/users`) em
[docs/06](docs/06-api-specification.md).

## Campanhas

Uma campanha manda o mesmo texto para uma lista de números por uma sessão, uma mensagem por número. Serve para falar
com muitos clientes sem que o WhatsApp restrinja ou derrube o número.

### Criar uma campanha

1. Abra **Campanhas**, escolha a sessão e clique **Nova campanha** (operador ou admin).
2. Dê um nome, cole os números ou carregue uma planilha (`.xlsx`, `.csv` ou `.txt`, até 2 MB), e escreva a
   mensagem. Vale um número por linha ou separados por vírgula, ponto e vírgula ou tab; espaços, parênteses,
   hífens e o `+` são ignorados. Grupos e números repetidos ficam de fora. O limite é de 5 000 números por
   campanha.
   - **Planilha com várias colunas:** o painel mostra as primeiras linhas e pede a coluna do telefone. Ele já
     sugere a coluna cujo cabeçalho fala em telefone, celular ou WhatsApp, ou a que tem mais células com cara de
     telefone. Só essa coluna entra; CPF, CEP e outros códigos ficam de fora. No `.xlsx` vale a primeira aba.
     Arquivos `.xls` antigos não são lidos: salve como `.xlsx` ou `.csv`.
   - **Código do país:** com a opção **Adicionar 55 (Brasil)** marcada (o padrão), um número brasileiro sem o 55
     (DDD + 8 dígitos, ou DDD + 9 dígitos começando com 9) recebe o 55, e o painel mostra quantos foram ajustados.
     Um número escrito com `+` nunca é alterado. A API (`POST .../campaigns`) não faz esse ajuste: quem a chama
     manda o número completo.
3. Clique **Iniciar** e confirme no diálogo, que mostra a sessão e o total de números.

Cada sessão tem no máximo uma campanha em andamento.

### Como o envio acontece

- Uma mensagem por vez, com 3 a 5 segundos entre uma e outra.
- O envio respeita a cota diária do anti-banimento da sessão (`SEND_PACING_*`). Quando a cota do dia acaba, a
  campanha espera a próxima tentativa sozinha e continua no dia seguinte (a cota vira às 00:00 UTC, 21:00 em
  Brasília).
- Se o WhatsApp põe uma restrição na conta, ou se a sessão desconecta, a campanha para de enviar e retoma quando a
  sessão volta a ficar pronta.
- Um reinício do gateway não perde a campanha: ela continua do próximo número. O número que estava sendo enviado
  na hora da queda fica como falha (`SEND_INTERRUPTED`) e não é reenviado, porque o WhatsApp pode já ter recebido.
- Um número que o WhatsApp recusa, ou que um plugin bloqueia, vira falha (`SEND_FAILED` ou `SEND_BLOCKED`) e a
  campanha segue para o próximo.

A tela de cada campanha (clique no nome dela na lista) mostra os contadores por status, a lista de destinatários
com filtro e paginação, e o motivo de uma campanha em andamento não estar enviando. Ela se atualiza sozinha a cada
5 segundos. O botão **Cancelar** pede confirmação; os números que ainda não receberam não recebem mais.

### A resposta do cliente

Quando um destinatário responde, ele passa a **Respondeu** e o webhook `message.received` daquela primeira resposta
traz `campaign: { "id": "...", "name": "..." }`. É por esse campo que o Hermes ou o n8n sabem que a conversa veio de
uma campanha e assumem o atendimento. As mensagens seguintes do mesmo cliente chegam sem o campo.

Para isso funcionar, a sessão precisa de um webhook assinando `message.received` que aponte para o fluxo do Hermes
ou do n8n. As rotas da API estão em [docs/06 §6.4.18](docs/06-api-specification.md#6418-campaigns-openmsg).

## Implantação

O OpenMsg roda com o `docker-compose.yml` do projeto numa VM Oracle Cloud Always Free (Ampere A1, ARM64), publicado
na internet por um **Cloudflare Tunnel** próprio. A VM não tem nenhuma porta nova aberta: o túnel sai da VM para a
Cloudflare, que cuida do HTTPS. A instância atual responde em `https://openmsg.devsrun.com`.

### Arquivos na VM

O código fica em `~/openmsg`. Além do repositório, há dois arquivos locais, que não vão para o Git:

**`docker-compose.override.yml`**: desliga o proxy do Docker (o painel não orquestra containers) e acrescenta o
túnel.

```yaml
services:
  docker-proxy:
    profiles: ['disabled']
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: openmsg-tunnel
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${TUNNEL_TOKEN:?TUNNEL_TOKEN ausente no .env}
    restart: unless-stopped
    networks:
      - openwa-network
    depends_on:
      - openwa-api
```

**`.env`** (permissão 600): as chaves abaixo, com valores que nunca devem ir para o chat nem para o Git.

| Variável                                    | Para quê                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `NODE_ENV=production`, `TZ`                 | Modo de produção e fuso horário dos logs                                  |
| `ENGINE_TYPE=baileys`                       | Motor sem Chrome, mais leve                                               |
| `DATABASE_TYPE=sqlite`                      | Banco local, no volume `openwa-data`                                      |
| `BASE_URL`, `DASHBOARD_URL`, `CORS_ORIGINS` | O endereço público (`https://openmsg.devsrun.com`)                        |
| `API_MASTER_KEY`, `API_KEY_PEPPER`          | Chave de admin da API (integrações) e o "sal" do hash das chaves          |
| `TRUSTED_PROXIES`                           | Sub-rede da `openwa-network`, para o OpenMsg ver o IP real de quem acessa |
| `TUNNEL_TOKEN`                              | Token do túnel `openmsg` na Cloudflare (Zero Trust → Networks → Tunnels)  |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`             | Cria o primeiro admin. Apague `ADMIN_PASSWORD` depois do primeiro acesso. |

No Compose, ponha a senha entre aspas simples (`ADMIN_PASSWORD='...'`). Sem aspas, um `$` ou um ` #` na senha
cortam o valor sem aviso.

Na Cloudflare, o túnel tem um único Public Hostname: `openmsg.devsrun.com` → `HTTP` → `openwa-api:2785`.

### Atualizar a VM

```bash
ssh servidor
cd ~/openmsg && git pull && docker compose up -d --build
docker ps --filter name=openwa-api        # aguardar "healthy"
```

Para mudar só o `.env`, basta `docker compose up -d` (sem `--build`).

## Trazer atualizações do OpenWA

O OpenWA recebe correções com frequência, inclusive quando o WhatsApp muda algo. Ficar muito tempo sem sincronizar
derruba sessões.

O remoto `upstream` aponta para o projeto original, e o `origin` para este fork:

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

O fork foi feito para gerar poucos conflitos: quase tudo o que é dele está em arquivos próprios.

| Arquivos só do OpenMsg (sem conflito)                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard/src/brand.ts`, `brand.css`, `components/BrandLogo.tsx`                                                                       |
| `dashboard/src/pages/Users.*`, `pages/Account.*`, `services/users.ts`, `hooks/useUsers.ts`                                              |
| `dashboard/src/pages/Campaigns.*`, `services/campaigns.ts`, `hooks/useCampaigns.ts`, `utils/{campaignRecipients,recipientTable,xlsx}.*` |
| `src/modules/auth/users.*`, `auth-login.controller.*`, `password-hash.ts`, `entities/user*.entity.ts`, `dto/user.dto.ts`                |
| `src/modules/campaign/` (inteiro)                                                                                                       |
| `src/database/migrations-main/1791000000000-CreateUserTables.ts`                                                                        |
| `src/database/migrations/1791100000000-AddCampaigns.ts`                                                                                 |

Os conflitos, quando aparecerem, devem cair em arquivos do projeto original que o fork alterou pontualmente:
`Login.tsx`, `App.tsx`, `Layout.tsx`, `auth.module.ts`, `app.module.ts`, `src/database/data-source.ts` e os
specs de migração que listam as entidades, o enum de auditoria, os catálogos de tradução, as folhas de
estilo em que o verde virou `var(--primary)`, a documentação e o `openapi.json`. Depois de resolver um merge:

```bash
npm run openapi:export                  # regenerar o openapi.json
cd dashboard && npm run i18n:check      # todas as chaves nos 15 idiomas
npm run typecheck && npm run lint && npm test && npm run build
```

Nunca renomeie nem apague um arquivo de `src/database/migrations-main/`: o banco registra cada migration pelo nome.

## Pendências conhecidas

- Os 13 idiomas além de português e inglês mostram em inglês os textos novos do OpenMsg.
- O anti-banimento (`SEND_PACING_ENABLED`) não está ligado no `.env` da VM. Sem ele, a campanha não tem cota
  diária e só respeita o intervalo entre mensagens. Ligar vale para todo envio da sessão, inclusive as respostas do
  Hermes e do n8n.
- Não há como excluir uma campanha: a lista de números fica guardada até a sessão ser excluída.
- Não há recuperação de senha por e-mail; o caminho é sempre um admin ou o `.env` da VM.
- Algumas falhas de teste no Windows (permissões de arquivo, quebras de linha) acontecem também no OpenWA original
  e não têm relação com o fork; o CI roda em Linux.
