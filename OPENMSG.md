# OpenMsg

O OpenMsg é um fork do [OpenWA](https://github.com/rmyndharis/OpenWA), um gateway de API para WhatsApp de código
aberto (licença MIT). O fork mantém o gateway do projeto original e acrescenta duas coisas: uma marca própria e o
login no painel por e-mail e senha, com gestão de usuários.

Este documento explica o que muda em relação ao OpenWA, como funcionam usuários e senhas, como o OpenMsg está
implantado e como trazer as atualizações do projeto original.

## O que muda em relação ao OpenWA

| Área             | No OpenWA                               | No OpenMsg                                                                      |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| Marca do painel  | Logo, nome e verde do OpenWA            | Logo OpenMsg (anel índigo), nome OpenMsg, paleta índigo                         |
| Login do painel  | Cola-se uma API key                     | E-mail e senha; a API key não abre mais o painel                                |
| Pessoas          | Não existe o conceito de usuário        | Página **Usuários** (só admin) e página **Minha conta** (todos)                 |
| Senhas           | Não se aplica                           | Senha provisória obrigatória de trocar, troca da própria senha, recuperação     |
| API e integração | API keys com papel (admin/operador/...) | Iguais: as API keys continuam sendo a credencial do n8n, do Hermes e de scripts |

A API, os motores (Baileys e whatsapp-web.js), os webhooks, os plugins e o resto do gateway não mudam.

## Papéis

Cada usuário tem um papel. O papel vale para tudo o que a pessoa faz no painel, porque cada login gera uma chave
com esse papel e o backend confere o papel em cada rota.

| Pode...                                                                                | Visualizador | Operador | Admin |
| -------------------------------------------------------------------------------------- | :----------: | :------: | :---: |
| Ver sessões, conversas, contatos, grupos e mensagens                                   |      ✓       |    ✓     |   ✓   |
| Enviar mensagens, criar e parear sessões, mexer em grupos, etiquetas, status e modelos |              |    ✓     |   ✓   |
| Configurar webhooks da sessão e regras de automação                                    |              |    ✓     |   ✓   |
| Chaves API, Usuários, Infraestrutura, Plugins, Registros, configurações e estatísticas |              |          |   ✓   |
| Trocar a própria senha em **Minha conta**                                              |      ✓       |    ✓     |   ✓   |

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

| Arquivos só do OpenMsg (sem conflito)                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ |
| `dashboard/src/brand.ts`, `brand.css`, `components/BrandLogo.tsx`                                                        |
| `dashboard/src/pages/Users.*`, `pages/Account.*`, `services/users.ts`, `hooks/useUsers.ts`                               |
| `src/modules/auth/users.*`, `auth-login.controller.*`, `password-hash.ts`, `entities/user*.entity.ts`, `dto/user.dto.ts` |
| `src/database/migrations-main/1791000000000-CreateUserTables.ts`                                                         |

Os conflitos, quando aparecerem, devem cair em arquivos do projeto original que o fork alterou pontualmente:
`Login.tsx`, `App.tsx`, `Layout.tsx`, `auth.module.ts`, o enum de auditoria, os catálogos de tradução, as folhas de
estilo em que o verde virou `var(--primary)`, a documentação e o `openapi.json`. Depois de resolver um merge:

```bash
npm run openapi:export                  # regenerar o openapi.json
cd dashboard && npm run i18n:check      # todas as chaves nos 15 idiomas
npm run typecheck && npm run lint && npm test && npm run build
```

Nunca renomeie nem apague um arquivo de `src/database/migrations-main/`: o banco registra cada migration pelo nome.

## Pendências conhecidas

- Os 13 idiomas além de português e inglês mostram em inglês os textos novos do OpenMsg.
- Não há recuperação de senha por e-mail; o caminho é sempre um admin ou o `.env` da VM.
- Algumas falhas de teste no Windows (permissões de arquivo, quebras de linha) acontecem também no OpenWA original
  e não têm relação com o fork; o CI roda em Linux.
