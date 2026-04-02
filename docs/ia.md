# Information Architecture

## Overview
This document outlines the information architecture for the Vistral platform, organizing content and functionality to support natural language and attachment-driven workflows while maintaining clear navigation for all user types.

## Site Structure

### Level 0: Root
- `/` - Main conversation interface (landing for authenticated users)
- `/auth` - Authentication flows
- `/admin` - Administrative dashboard
- `/models` - Model discovery and management (user domain, not a separate owner portal)
- `/account` - User account management

### Level 1: Conversation Interface
- `/` - Primary chat interface
  - `/new` - Start new conversation
  - `/c/:conversationId` - Specific conversation view
  - `/attachments` - Manage conversation attachments

### Level 2: Authentication
- `/auth/login` - Login form
- `/auth/signup` - Registration form
- `/auth/forgot-password` - Password reset
- `/auth/verify-email` - Email verification

### Level 3: Administration
- `/admin/dashboard` - Admin overview
- `/admin/models` - Model management
  - `/admin/models/pending` - Pending approvals
  - `/admin/models/rejected` - Rejected models
  - `/admin/models/archived` - Archived models
- `/admin/users` - User management
- `/admin/audit` - Audit logs
- `/admin/settings` - System settings

### Level 4: Model Management
- `/models/explore` - Discover public models
- `/models/my-models` - User-owned and authorized models
- `/models/create` - Model creation wizard
- `/models/:modelId` - Model detail page
  - `/models/:modelId/chat` - Chat with specific model
  - `/models/:modelId/configure` - Model configuration
  - `/models/:modelId/analytics` - Model analytics
  - `/models/:modelId/version-history` - Version management

### Level 5: Account Management
- `/account/profile` - Profile management
- `/account/security` - Security settings
- `/account/preferences` - User preferences
- `/account/billing` - Billing information
- `/account/api-keys` - API key management

## Navigation Patterns

### Primary Navigation (Top Bar)
- Logo/Brand (links to main conversation)
- Search functionality
- User profile menu
- Notifications
- Quick access to recent conversations

### Secondary Navigation (Sidebar)
- New conversation button
- Recent conversations list
- Saved conversations
- Model favorites
- File attachments from current session

### Contextual Navigation (Within Views)
- Breadcrumb navigation for multi-step processes
- Progress indicators for wizards
- Related content suggestions
- Action-based navigation buttons

## Content Organization

### Conversation Interface Layout
```
┌─────────────────────────────────────┐
│ Header: Logo | Search | User Menu   │
├─────────────────────────────────────┤
│ Sidebar        │     Main Area      │
│                │                   │
│ • New Conv     │   Conversation    │
│ • Recent       │      History      │
│ • Attachments  │                   │
│ • Favorites    │   Active Chat     │
│                │                   │
└─────────────────────────────────────┘
```

### Multi-Step Process Layout
```
┌─────────────────────────────────────┐
│ Progress Bar (Top Indication)       │
├─────────────────────────────────────┤
│ Header: Step X of Y | Back | Next   │
├─────────────────────────────────────┤
│         Main Content Area           │
│                                     │
│    Current Step Content             │
│                                     │
│    [Advanced Parameters Section]    │
│    (Collapsed by Default)          │
│                                     │
└─────────────────────────────────────┘
```

## File Attachment System
- All uploaded files visible in sidebar during session
- Status indicators (uploading, processing, ready, error)
- Delete capability for each file
- Drag-and-drop support
- Preview capability where applicable

## State Management
- Conversation contexts preserved across page refreshes
- Multi-step process state maintained in browser storage
- User preferences saved to backend
- File upload states persisted during session

## Responsive Behavior
- Mobile: Collapsed sidebar by default, swipe to reveal
- Tablet: Adaptive layout with optimized touch targets
- Desktop: Full sidebar and multi-panel views

## Accessibility Considerations
- Keyboard navigation for all interactive elements
- Screen reader compatibility for conversation content
- Alt text for all visual elements
- High contrast mode support
- Focus management during dynamic content updates
