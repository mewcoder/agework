import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConfirmDelete, useBooleanConfirmDelete } from './confirm-delete-dialog';

describe('useConfirmDelete', () => {
  it('should initialize with no target and closed state', () => {
    const { result } = renderHook(() => useConfirmDelete<{ id: string; name: string }>());

    expect(result.current.target).toBeUndefined();
    expect(result.current.isOpen).toBe(false);
  });

  it('should set target and open state when requestDelete is called', () => {
    const { result } = renderHook(() => useConfirmDelete<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.requestDelete(item);
    });

    expect(result.current.target).toEqual(item);
    expect(result.current.isOpen).toBe(true);
  });

  it('should clear target and close state when cancelDelete is called', () => {
    const { result } = renderHook(() => useConfirmDelete<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.requestDelete(item);
    });

    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.cancelDelete();
    });

    expect(result.current.target).toBeUndefined();
    expect(result.current.isOpen).toBe(false);
  });

  it('should handle multiple delete requests', () => {
    const { result } = renderHook(() => useConfirmDelete<{ id: string; name: string }>());
    const item1 = { id: '1', name: 'Item 1' };
    const item2 = { id: '2', name: 'Item 2' };

    act(() => {
      result.current.requestDelete(item1);
    });

    expect(result.current.target).toEqual(item1);

    act(() => {
      result.current.requestDelete(item2);
    });

    expect(result.current.target).toEqual(item2);
    expect(result.current.isOpen).toBe(true);
  });

  it('should close when onOpenChange is called with false', () => {
    const { result } = renderHook(() => useConfirmDelete<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.requestDelete(item);
    });

    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.onOpenChange(false);
    });

    expect(result.current.target).toBeUndefined();
    expect(result.current.isOpen).toBe(false);
  });

  it('should not close when onOpenChange is called with true', () => {
    const { result } = renderHook(() => useConfirmDelete<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.requestDelete(item);
    });

    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.onOpenChange(true);
    });

    expect(result.current.target).toEqual(item);
    expect(result.current.isOpen).toBe(true);
  });
});

describe('useBooleanConfirmDelete', () => {
  it('should initialize with closed state', () => {
    const { result } = renderHook(() => useBooleanConfirmDelete());

    expect(result.current.isOpen).toBe(false);
  });

  it('should open when open is called', () => {
    const { result } = renderHook(() => useBooleanConfirmDelete());

    act(() => {
      result.current.open();
    });

    expect(result.current.isOpen).toBe(true);
  });

  it('should close when close is called', () => {
    const { result } = renderHook(() => useBooleanConfirmDelete());

    act(() => {
      result.current.open();
    });

    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.close();
    });

    expect(result.current.isOpen).toBe(false);
  });

  it('should handle multiple open/close cycles', () => {
    const { result } = renderHook(() => useBooleanConfirmDelete());

    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.close();
    });
    expect(result.current.isOpen).toBe(false);

    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);
  });
});
