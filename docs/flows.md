# User Flows and Process Documentation

## Overview
This document details the primary user flows and business processes for the Vistral platform, focusing on natural language and attachment-driven interactions while maintaining clear progress indicators and state management.

## Primary User Flows

### Flow 1: Basic Model Interaction
**Actor**: User
**Goal**: Get insights from a visual model through conversation

1. User navigates to main conversation interface
   - Entry path: `/` (dual entry) -> `/workspace/chat`
2. System displays welcome message and recent conversations
3. User selects a model to interact with (or system suggests default)
4. User types natural language query
5. User attaches relevant files if needed (drag-and-drop or click-to-upload)
6. System shows file status (uploading, processing, ready)
7. User submits query
8. System processes request and displays response
9. User continues conversation or ends session
10. System saves conversation for future reference

**Alternative Paths**:
- If no model selected → System prompts to select or explore models
- If file upload fails → System shows error and allows retry
- If model unavailable → System suggests alternative models

### Flow 2: Model Upload and Publishing
**Actor**: User
**Goal**: Publish a new visual model to the platform (for owned/authorized model scope)

1. User navigates to model management section
2. User clicks "Create New Model" button
3. System presents multi-step wizard with progress indicator
4. Step 1: Model metadata (name, description, tags)
5. Step 2: Model file upload with status indicators
6. Step 3: Configuration parameters (advanced options collapsed by default)
7. Step 4: Privacy and access settings
8. User submits model for approval
9. System queues model for review process
10. System sends confirmation to user

**Alternative Paths**:
- If file upload fails → Return to Step 2 with error message
- If metadata incomplete → Highlight required fields
- If user exits mid-flow → Save draft and allow resume

### Flow 3: Approval Process
**Actor**: Administrator
**Goal**: Review and approve submitted models

1. System notifies admin of pending model submissions
2. Admin navigates to approval queue
3. System displays pending models with priority indicators
4. Admin selects model to review
5. System shows model details, files, and configuration
6. Admin tests model functionality
7. Admin approves or rejects model
8. If approved → System publishes model and notifies the submitting user
9. If rejected → System sends feedback to the submitting user and moves to rejected queue
10. System logs approval action for audit trail

### Flow 4: Multi-Step Training Pipeline
**Actor**: User
**Goal**: Retrain a model with new data (for owned/authorized model scope)

1. User selects existing model for retraining
2. System shows model dashboard with training options
3. User selects "Retrain Model" option
4. System opens multi-step training wizard with top progress bar
5. Step 1: Select training dataset (with file attachment system)
6. Step 2: Configure training parameters (advanced options collapsed)
7. Step 3: Set resource allocation and schedule
8. Step 4: Review and confirm settings
9. User confirms to start training
10. System begins training process and shows progress
11. System notifies user when complete

## File Attachment Flows

### Standard File Attachment
1. User clicks attachment button or drags file to drop zone
2. System shows file in attachment panel with status "Uploading"
3. System updates status to "Processing" during validation
4. System updates status to "Ready" when available for use
5. File remains visible in sidebar throughout session
6. User can remove file using delete icon
7. Removed files are cleared from session

### Failed File Upload
1. System detects upload failure
2. File status changes to "Error" with error message
3. User sees option to retry or remove file
4. If retry selected → Resume upload process
5. If remove selected → Clear file from attachment list

## Multi-Step Process Patterns

### Progress Indication
- Top-of-page progress bar showing current step
- Step counter in header (e.g., "Step 2 of 4")
- Visual indicators of completed steps
- Clear back/forward navigation

### State Persistence
- Form data saved automatically as user progresses
- Ability to exit and resume process later
- Session-based temporary storage
- Draft saving for complex processes

### Advanced Options Management
- Advanced parameter sections collapsed by default
- Clear expand/collapse controls
- Visual indicator of available advanced options
- User preference for default visibility

## Edge Deployment Flows

### Model Deployment
1. Admin selects model for edge deployment
2. System validates model compatibility
3. System identifies suitable edge locations
4. Admin selects target locations
5. System begins deployment process
6. Real-time progress tracking
7. Health monitoring of deployed models
8. Automatic rollback on failure

## Error Handling Flows

### Service Unavailable
1. System detects service unavailability
2. User receives clear error message
3. System suggests retry or alternative actions
4. Background retry mechanism initiated
5. User notified when service restored

### Permission Denied
1. System detects insufficient permissions
2. User receives clear explanation of limitation
3. System suggests contacting administrator if appropriate
4. Alternative pathways suggested when available

## System Initiation Flows

### First-Time User Onboarding
1. New user completes registration
2. System presents guided tour of conversation interface
3. User completes profile setup
4. System suggests popular models to try
5. User attempts first conversation
6. System provides contextual help as needed

## Audit Trail Flows

### Activity Logging
1. System automatically logs significant user actions
2. Timestamp, user ID, and action details recorded
3. Model interactions tracked for compliance
4. Administrative actions logged separately
5. Audit reports generated periodically
6. Compliance officers review logs as needed

## Performance Considerations
- Critical flows should load within 2 seconds
- File uploads should provide continuous progress feedback
- Long-running processes should be cancellable
- Error states should provide clear recovery paths
- Mobile flows optimized for touch interactions

## Validation Points
- All flows tested with actual user scenarios
- Accessibility requirements verified at each step
- Performance benchmarks met across all flows
- Error handling robust for edge cases
