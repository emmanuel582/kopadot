import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSession, pauseSession, isSessionPaused, destroySession } from '../src/agent/conversationMgr.js';

describe('conversationMgr — Session Pausing', () => {
  it('should not be paused by default', () => {
    const session = getSession('test-session-1');
    assert.equal(isSessionPaused('test-session-1'), false);
    destroySession('test-session-1');
  });

  it('should pause a session correctly', () => {
    getSession('test-session-2');
    pauseSession('test-session-2', 24); // Pause for 24 hours
    assert.equal(isSessionPaused('test-session-2'), true);
    destroySession('test-session-2');
  });

  it('should unpause a session when paused with 0 hours', () => {
    getSession('test-session-3');
    pauseSession('test-session-3', 24); // Pause for 24 hours
    assert.equal(isSessionPaused('test-session-3'), true);
    
    // Unpause
    pauseSession('test-session-3', 0);
    assert.equal(isSessionPaused('test-session-3'), false);
    
    destroySession('test-session-3');
  });
});
