# Vistral - AI-Native Visual Model Platform

## Overview
Vistral is an AI-native visual model platform that provides a natural language and attachment-driven interface for visual model interactions. Built on RVision's foundation, it supports two system roles (users and administrators) with comprehensive functionality for model hosting, training, approval, publishing, edge inference, and auditing.

## Vision
Unlike traditional dashboard-based interfaces, Vistral follows a conversational approach similar to ChatGPT, allowing users to interact with visual models through natural language and file attachments. The platform maintains RVision's core business logic while providing a modern, intuitive user experience across the entire site.

## Core Features
- Natural language interaction with visual models
- Attachment-driven workflows (images, documents, datasets)
- Two-role access model (users, admins) with ownership-based model permissions
- Model hosting and deployment
- Training pipeline management
- Approval and auditing workflows
- Edge inference capabilities
- Multi-step processes with progress indicators
- Advanced parameter controls (collapsed by default)
- Persistent file upload states (visible, deletable, status-indicated)

## Architecture
- Frontend: AI-native interface with conversational flow
- Backend: Model management, inference, and orchestration
- Infrastructure: Scalable deployment and edge computing support

## Getting Started
1. Clone the repository.
2. Read collaboration rules in `AGENTS.md`.
3. Review product contracts in:
   - `docs/prd.md`
   - `docs/ia.md`
   - `docs/flows.md`
   - `docs/data-model.md`
   - `docs/api-contract.md`
4. Follow local setup instructions in `docs/setup.md`.

## Repository Working Model (How Codex should work in this repo)
- Collaboration and execution rules: `AGENTS.md`
- Product and engineering contracts: `docs/*`
- Reusable skills: `.agents/skills/`
- Delivery order: plan first, align contracts, then implement

## Contributing
Please read `docs/contributing.md` before opening a change.


## 中文文档
- 仓库说明（中文）：`README.zh-CN.md`
- 协作规则（中文）：`AGENTS.zh-CN.md`
- Setup（中文）：`docs/setup.zh-CN.md`
- Contributing（中文）：`docs/contributing.zh-CN.md`
- PRD（中文）：`docs/prd.zh-CN.md`
- IA（中文）：`docs/ia.zh-CN.md`
- Flows（中文）：`docs/flows.zh-CN.md`
- Data Model（中文）：`docs/data-model.zh-CN.md`
- API Contract（中文）：`docs/api-contract.zh-CN.md`

## License
License file is not yet added in this baseline; add one before production distribution.


## Development (Round 1 Baseline)
1. `npm install`
2. `npm run dev`
3. Open `http://localhost:5173`

### Implemented in this round
- Shared app shell and unified theme
- Dual work entry: AI-native conversation workspace + professional console
- Conversation workflow with attachment upload/status/delete and mock assistant responses
- Model pages: explore / my-models / create (stepper + advanced collapsed)
- Auth mock: login/register (`register` cannot create `admin`)
- Ownership-based model filtering and create permission via capabilities
- Initial schema in `db/schema.sql`


## Docker Deployment
- Quick guide: `docs/deployment.docker.md`
- Build: `docker build -t vistral-web:round1 .`
- Run: `docker run --rm -p 8080:80 vistral-web:round1`
