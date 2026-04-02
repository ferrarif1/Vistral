---
name: product-architect
description: Define product structure, flows, information architecture, and implementation plans for the AI-native vision platform before coding begins.
---
## Overview
This skill guides architectural decisions for the Vistral platform, ensuring alignment with product vision, scalability requirements, and business objectives. It focuses on AI-native interfaces, natural language processing, and visual model integration.

## Core Principles

### 1. AI-Native First Design
- Prioritize conversational interfaces over traditional forms
- Design for natural language input and output
- Enable rich media attachments as first-class citizens
- Support context-aware interactions across sessions

### 2. Scalable Architecture
- Design for horizontal scaling from day one
- Implement proper separation of concerns
- Use event-driven architectures for loose coupling
- Plan for distributed inference workloads

### 3. Security-First Approach
- Encrypt all data in transit and at rest
- Implement zero-trust architecture principles
- Plan for compliance requirements (GDPR, CCPA, etc.)
- Design for auditability and transparency

### 4. Performance Optimization
- Optimize for sub-second response times for core interactions
- Implement intelligent caching strategies
- Design for efficient resource utilization
- Plan for edge computing deployment

## Architecture Guidelines

### System Boundaries
- Define clear service boundaries
- Minimize cross-service dependencies
- Implement circuit breakers for resilience
- Design for graceful service degradation

### Data Flow
- Design for real-time data streaming where appropriate
- Implement proper data lineage tracking
- Plan for data consistency requirements
- Design for data privacy and retention policies

### Integration Points
- Design robust API contracts
- Plan for third-party integrations
- Implement proper error handling and retries
- Design for backward compatibility

## Technology Stack Recommendations

### Frontend Architecture
- Framework: React with TypeScript
- State Management: Zustand or Redux Toolkit
- UI Components: Radix UI or similar accessible library
- Forms: React Hook Form with Zod validation
- Real-time: WebSocket connections for live updates
- File Handling: Progress tracking and drag-and-drop support

### Backend Architecture
- Language: Node.js with TypeScript or Python
- Framework: Express/Fastify or FastAPI
- Database: PostgreSQL for relational data, Redis for caching
- File Storage: Object storage (S3-compatible)
- Message Queue: Redis or RabbitMQ for async processing
- Authentication: JWT with refresh token rotation

### ML/AI Infrastructure
- Model Serving: TensorFlow Serving, TorchServe, or custom solution
- Containerization: Docker with Kubernetes orchestration
- Edge Computing: Design for distributed inference
- Monitoring: Prometheus/Grafana for metrics

## Quality Assurance

### Performance Benchmarks
- API response times < 200ms for 95th percentile
- File upload progress updates every 100ms
- Page load times < 2 seconds
- Model inference times based on model complexity

### Scalability Targets
- Support 10,000+ concurrent users
- Handle 1M+ daily model inference requests
- Support 1TB+ monthly file uploads
- Maintain 99.9% availability SLA

### Security Standards
- Regular security audits and penetration testing
- Automated vulnerability scanning
- Secure coding practices and training
- Incident response and recovery procedures

## Decision Framework

### When to Use Microservices vs Monolith
- Use microservices for: distinct business capabilities, different scaling requirements, independent deployment needs
- Use monolith for: early-stage development, tight coupling requirements, simpler operational needs

### Data Storage Decisions
- Use PostgreSQL for: structured data, complex relationships, ACID transactions
- Use MongoDB for: semi-structured data, flexible schemas, document-based storage
- Use Redis for: caching, session storage, real-time data
- Use Object Storage for: large files, static assets, backups

### Caching Strategy
- Application-level caching for expensive computations
- CDN for static assets and images
- Database query result caching
- Client-side caching for UI components and preferences

## Implementation Patterns

### Multi-Step Process Architecture
- Implement state machines for complex workflows
- Use saga pattern for distributed transactions
- Provide clear progress indicators
- Enable save/resume functionality

### File Attachment System
- Implement chunked upload for large files
- Provide real-time progress tracking
- Validate file types and sizes
- Implement virus scanning for security

### Advanced Parameter Management
- Collapse advanced options by default
- Use progressive disclosure for complex settings
- Implement parameter validation and constraints
- Provide parameter presets for common use cases

## Risk Assessment

### Technical Risks
- Model inference latency affecting user experience
- Scalability challenges with increasing user base
- Data privacy and compliance requirements
- Third-party service dependencies

### Mitigation Strategies
- Performance monitoring and optimization
- Gradual scaling with load testing
- Privacy-by-design implementation
- Multiple vendor strategies and fallbacks

## Success Metrics

### Architecture Quality
- System uptime and reliability
- Response time performance
- Resource utilization efficiency
- Code maintainability scores

### Business Impact
- User engagement and retention
- Model usage and adoption rates
- Time to market for new features
- Operational cost efficiency

## Review Checklist

Before finalizing architectural decisions, ensure:
- [ ] Alignment with product requirements
- [ ] Scalability projections are realistic
- [ ] Security and compliance requirements met
- [ ] Performance benchmarks achievable
- [ ] Team skills and capacity considered
- [ ] Cost implications evaluated
- [ ] Migration strategy from existing systems (if applicable)
- [ ] Monitoring and observability planned
- [ ] Disaster recovery procedures defined
- [ ] Documentation and knowledge transfer planned

## Common Anti-Patterns to Avoid

- Over-engineering for hypothetical future needs
- Ignoring network latency in distributed systems
- Tight coupling between services
- Premature optimization without measurement
- Inconsistent error handling across services
- Hardcoding configuration values
- Neglecting security in early development stages
- Insufficient logging and monitoring
