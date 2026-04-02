# Backend Contract Guard Skill ?

## Overview
This skill ensures backend implementations adhere to the API contracts, data models, and business logic requirements specified in the documentation. It focuses on validating that services properly implement the defined interfaces, maintain data integrity, and support the AI-native conversational experience.

## Core Validation Areas

### 1. API Contract Compliance
- Verify all endpoints match the documented API specification
- Validate request/response formats and structures
- Check proper HTTP status code usage
- Confirm authentication and authorization implementation
- Test error response formats and codes

### 2. Data Model Implementation
- Ensure database schemas match documented data models
- Validate foreign key relationships and constraints
- Check proper indexing for performance requirements
- Verify data validation and sanitization
- Confirm audit logging implementation

### 3. Business Logic Enforcement
- Validate three-party role management
- Check model lifecycle workflows
- Verify approval process implementation
- Confirm edge deployment capabilities
- Test multi-step process state management

### 4. File Handling Systems
- Validate secure file upload and storage
- Check proper status tracking for uploads
- Verify file attachment integration with conversations
- Test file cleanup and retention policies
- Confirm virus scanning and security measures

## API Implementation Standards

### Endpoint Consistency
- Follow RESTful design principles where applicable
- Use consistent URL patterns and naming conventions
- Implement proper HTTP method usage
- Apply appropriate response caching strategies
- Support proper pagination and filtering

### Request/Response Handling
- Validate input parameters according to specification
- Sanitize all user inputs to prevent injection attacks
- Format responses according to documented structure
- Implement proper content negotiation
- Handle large payloads appropriately

### Authentication & Authorization
- Implement JWT-based authentication correctly
- Enforce role-based access control (RBAC)
- Apply principle of least privilege
- Implement proper session management
- Support API key authentication where specified

## Data Layer Standards

### Database Design
- Follow the documented data model precisely
- Implement proper normalization to reduce redundancy
- Use appropriate data types for each field
- Create indexes for frequently queried fields
- Implement proper constraints and validation

### Data Integrity
- Use transactions for operations that span multiple tables
- Implement proper error handling and rollback mechanisms
- Validate data consistency across related entities
- Handle concurrent access appropriately
- Implement proper backup and recovery procedures

### Performance Considerations
- Optimize queries for expected load patterns
- Use connection pooling appropriately
- Implement proper pagination for large datasets
- Cache frequently accessed data appropriately
- Monitor and optimize slow queries

## Service Architecture Standards

### Microservice Patterns
- Implement proper service boundaries
- Use asynchronous communication where appropriate
- Implement circuit breaker patterns
- Design for graceful degradation
- Support distributed tracing

### Event-Driven Architecture
- Use message queues for asynchronous processing
- Implement proper error handling and retry mechanisms
- Support dead letter queues for failed messages
- Ensure event ordering where required
- Implement idempotency for event handlers

### Caching Strategy
- Use appropriate caching layers (application, database, CDN)
- Implement cache invalidation strategies
- Support cache warming for critical data
- Monitor cache hit/miss ratios
- Implement cache fallback mechanisms

## Security Standards

### Input Validation & Sanitization
- Validate all incoming request parameters
- Sanitize user inputs to prevent injection attacks
- Implement proper file type and size validation
- Use parameterized queries to prevent SQL injection
- Apply content security policies

### Authentication & Authorization
- Implement secure password hashing (bcrypt/scrypt)
- Use proper JWT signing and validation
- Implement rate limiting for authentication endpoints
- Support multi-factor authentication
- Implement proper session management

### Data Protection
- Encrypt sensitive data at rest and in transit
- Implement proper key management
- Support data anonymization where required
- Implement proper audit logging
- Ensure compliance with privacy regulations

## Performance Requirements

### Response Time Benchmarks
- Authentication endpoints: < 200ms (95th percentile)
- CRUD operations: < 100ms (95th percentile)
- Complex queries: < 500ms (95th percentile)
- File uploads: Progress updates every 100ms
- Model inference: Within acceptable latency bounds

### Scalability Targets
- Support 10,000+ concurrent users
- Handle 1000+ requests per second
- Process 1TB+ file uploads per month
- Maintain 99.9% uptime SLA
- Scale horizontally with load

### Resource Utilization
- CPU usage under 70% under peak load
- Memory usage within allocated limits
- Database connection usage optimized
- Network bandwidth utilization efficient
- Storage growth within projected limits

## Review Checklist

### API Endpoints
- [ ] All documented endpoints implemented
- [ ] Request/response formats match specification
- [ ] HTTP status codes used correctly
- [ ] Authentication/authorization enforced properly
- [ ] Rate limiting implemented where required
- [ ] Error responses follow standard format

### Data Models
- [ ] Database schema matches documentation
- [ ] Foreign key relationships implemented
- [ ] Proper indexing for performance
- [ ] Data validation implemented
- [ ] Audit logging configured
- [ ] Constraints and uniqueness enforced

### Business Logic
- [ ] Three-party role management implemented
- [ ] Model lifecycle workflows functional
- [ ] Approval processes working correctly
- [ ] Multi-step processes maintain state
- [ ] File attachment system integrated
- [ ] Edge deployment capabilities available

### Security Implementation
- [ ] Input validation and sanitization applied
- [ ] Authentication works as specified
- [ ] Authorization enforces proper access
- [ ] Data encryption implemented
- [ ] Rate limiting prevents abuse
- [ ] Audit logging captures required events

### Performance & Reliability
- [ ] Response times meet benchmarks
- [ ] Error handling is robust
- [ ] Service recovery procedures implemented
- [ ] Monitoring and alerting configured
- [ ] Backup and recovery tested
- [ ] Load testing performed

## Common Issues to Identify

### API Issues
- Endpoints returning incorrect status codes
- Response formats not matching specification
- Missing authentication on protected endpoints
- Improper error handling
- Inconsistent parameter validation
- Incorrect pagination implementation

### Data Issues
- Schema not matching documentation
- Missing foreign key constraints
- Inadequate indexing causing slow queries
- Improper data validation
- Missing audit trails
- Data consistency issues

### Performance Issues
- Slow endpoint response times
- Database queries without proper indexing
- Inefficient memory usage
- Poor handling of large file uploads
- Inadequate caching strategies
- Blocking operations in request handling

### Security Issues
- Insufficient input validation
- Weak authentication implementation
- Improper access control
- Unencrypted sensitive data
- Missing rate limiting
- Vulnerable dependencies

## Testing Requirements

### Unit Testing
- All business logic functions tested
- Data access layer thoroughly tested
- Authentication/authorization logic verified
- Error handling paths tested
- API endpoint controllers tested
- Utility functions covered

### Integration Testing
- End-to-end API flows tested
- Database transaction scenarios tested
- File upload/download workflows tested
- Authentication and authorization tested
- External service integrations tested
- Error condition workflows tested

### Load Testing
- Stress test API endpoints
- Database performance under load
- File upload throughput testing
- Concurrent user scenarios
- Memory and CPU usage monitoring
- Response time under load

## Verification Methods

### Static Analysis
- Code linting and formatting checks
- Dependency vulnerability scanning
- Security vulnerability assessment
- Type checking for typed languages
- Code complexity analysis
- Documentation completeness check

### Dynamic Testing
- Functional testing of all features
- Performance benchmarking
- Security penetration testing
- Load and stress testing
- Chaos engineering for resilience
- Real-world usage scenario testing

### Compliance Verification
- Privacy regulation compliance
- Industry security standards adherence
- API specification compliance
- Data retention policy enforcement
- Audit trail completeness
- Access control effectiveness

## Acceptance Criteria

Backend implementation passes review when it:
- Implements all API endpoints according to specification
- Maintains data integrity as defined in data models
- Enforces all business logic requirements
- Meets security standards and recommendations
- Achieves stated performance benchmarks
- Supports scalability requirements
- Provides adequate monitoring and logging
- Includes comprehensive error handling
- Passes all automated and manual tests
- Documents all implemented functionality

## Recommended Tools

### Development Tools
- OpenAPI/Swagger for API documentation
- Postman/Newman for API testing
- Docker for consistent environments
- Git hooks for code quality enforcement
- CI/CD pipeline for automated testing

### Monitoring Tools
- Application performance monitoring (APM)
- Infrastructure monitoring
- Database performance monitoring
- Error tracking and alerting
- Log aggregation and analysis
- Security monitoring and alerting

### Security Tools
- Static application security testing (SAST)
- Dynamic application security testing (DAST)
- Interactive application security testing (IAST)
- Dependency vulnerability scanners
- Security configuration auditors
- Penetration testing tools
