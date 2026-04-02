# Frontend Parity Review Skill

## Overview
This skill ensures frontend implementations maintain consistency with the AI-native conversational interface design, proper file attachment handling, multi-step process indicators, and advanced parameter management as specified in the product requirements.

## Core Review Areas

### 1. Conversational Interface Consistency
- Verify natural language input/output patterns
- Check conversation context preservation
- Validate message threading and history display
- Confirm proper handling of different message types (text, file, system)

### 2. File Attachment System
- Confirm files remain visible in UI during session
- Verify status indicators (uploading, processing, ready, error)
- Test delete functionality for uploaded files
- Check drag-and-drop and click-to-upload options
- Validate file previews where applicable

### 3. Multi-Step Process Indicators
- Verify top-level progress bars for multi-step processes
- Check step counters and completion indicators
- Test back/forward navigation functionality
- Confirm state persistence across steps
- Validate ability to resume interrupted processes

### 4. Advanced Parameter Controls
- Verify advanced options are collapsed by default
- Test expand/collapse functionality
- Check visual indicators for available advanced options
- Confirm user preference persistence for visibility
- Validate parameter validation and constraints

## UI/UX Standards

### Visual Consistency
- Maintain consistent spacing, typography, and color palette
- Follow accessibility standards (WCAG 2.1 AA minimum)
- Ensure responsive design across device sizes
- Use appropriate loading states and skeleton screens

### Interaction Patterns
- Provide clear visual feedback for user actions
- Maintain consistent button and form behaviors
- Implement proper focus management
- Use appropriate animations and transitions

### State Management
- Preserve conversation history across page refreshes
- Maintain multi-step process state
- Save user preferences appropriately
- Handle error states gracefully

## Technical Implementation Review

### Component Architecture
- Use reusable, well-documented components
- Implement proper prop drilling or state management
- Follow consistent naming conventions
- Maintain separation of concerns

### Performance Considerations
- Optimize for fast initial load times
- Implement lazy loading for non-critical content
- Use efficient rendering patterns
- Minimize bundle size and dependencies

### Accessibility Requirements
- Proper semantic HTML structure
- Keyboard navigation support
- Screen reader compatibility
- Sufficient color contrast ratios
- Focus indicators for interactive elements

## Review Checklist

### Conversation Interface
- [ ] Messages display in chronological order
- [ ] User input area clearly visible and accessible
- [ ] File attachment button easily discoverable
- [ ] Conversation history persists across sessions
- [ ] Proper loading states during model processing

### File Attachment System
- [ ] Files displayed in sidebar during session
- [ ] Status indicators clearly visible and accurate
- [ ] Delete functionality available for each file
- [ ] Drag-and-drop zone highlighted appropriately
- [ ] File previews shown when possible
- [ ] Error handling for failed uploads implemented

### Multi-Step Processes
- [ ] Progress bar visible at top of process
- [ ] Current step clearly indicated
- [ ] Back/forward navigation available
- [ ] Form data preserved when navigating between steps
- [ ] Process can be resumed if interrupted
- [ ] Clear step titles and descriptions

### Advanced Parameters
- [ ] Advanced sections collapsed by default
- [ ] Expand/collapse controls clearly visible
- [ ] Visual indicator for sections with content
- [ ] User preferences for visibility saved
- [ ] Form validation applied to advanced options

### General UI Elements
- [ ] Loading states for all asynchronous operations
- [ ] Error messages are user-friendly and actionable
- [ ] Success states clearly communicated
- [ ] Empty states appropriately handled
- [ ] Hover and focus states implemented
- [ ] Mobile responsiveness verified

## Common Issues to Identify

### Usability Problems
- Unclear navigation or user pathway
- Missing progress indicators in multi-step flows
- Advanced options not properly collapsed
- File status indicators not updating in real-time
- Inconsistent interaction patterns across the UI

### Technical Issues
- Memory leaks in long-running conversations
- Poor performance with many attached files
- State synchronization issues between components
- Inefficient data fetching patterns
- Improper error boundary implementations

### Accessibility Issues
- Insufficient keyboard navigation
- Poor screen reader experience
- Low contrast text or elements
- Missing alt text for images
- Inadequate focus indicators

## Verification Methods

### Manual Testing
- Complete end-to-end user flows
- Test with different file types and sizes
- Verify behavior across different browsers
- Test with assistive technologies
- Simulate network conditions and failures

### Automated Testing
- Unit tests for individual components
- Integration tests for complex interactions
- Cypress for end-to-end testing
- axe-core for accessibility testing
- Lighthouse for performance auditing

### Cross-Browser Compatibility
- Test in Chrome, Firefox, Safari, Edge
- Verify mobile browser compatibility
- Check behavior in different operating systems
- Validate touch interaction patterns

## Acceptance Criteria

A frontend implementation passes review when it:
- Matches the conversational interface design specifications
- Properly implements file attachment visibility and controls
- Shows clear progress indicators for multi-step processes
- Correctly collapses advanced parameters by default
- Meets accessibility standards
- Performs adequately under expected load
- Works consistently across targeted browsers/devices
- Provides appropriate error handling and user feedback
- Maintains visual consistency with brand guidelines

## Recommended Tools

### Testing Tools
- Storybook for component development and documentation
- Jest/React Testing Library for unit/integration tests
- Cypress for end-to-end testing
- axe-core for accessibility testing
- Lighthouse for performance auditing

### Development Tools
- ESLint with React-specific rules
- Prettier for code formatting
- TypeScript for type safety
- React Developer Tools for debugging
- Browser developer tools for performance analysis

## Feedback Delivery

When providing feedback, structure it as:
1. Issue identification with specific component/page
2. Impact on user experience
3. Recommended solution approach
4. Priority level (critical, high, medium, low)
5. Relevant specification reference
