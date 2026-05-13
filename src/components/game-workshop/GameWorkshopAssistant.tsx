import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ButtonLink } from '../ui/Button';
import type {
  GameWorkshopAssistantMessage,
  GameWorkshopAssistantSuggestion,
  GameWorkshopRoomId,
  GameWorkshopRoomSnapshot
} from '../../features/gameWorkshopSnapshot';
import { pixelWorkshopCharacterAssets } from '../../features/pixelWorkshopAssets';

interface GameWorkshopAssistantProps {
  activeRoomId: GameWorkshopRoomId;
  activeRoom: GameWorkshopRoomSnapshot | null;
  messages: GameWorkshopAssistantMessage[];
  suggestions: GameWorkshopAssistantSuggestion[];
  variant?: 'floating' | 'docked';
}

const storageKey = 'vistral-game-workshop-assistant-position';
const openClawSprite = pixelWorkshopCharacterAssets.openClaw;

type AssistantPosition = {
  x: number;
  y: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function GameWorkshopAssistant({
  activeRoomId,
  activeRoom,
  messages,
  suggestions,
  variant = 'floating'
}: GameWorkshopAssistantProps) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(variant === 'floating');
  const [dragging, setDragging] = useState(false);
  const [position, setPosition] = useState<AssistantPosition>({ x: 0, y: 0 });
  const [draft, setDraft] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<AssistantPosition>;
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        setPosition({ x: parsed.x, y: parsed.y });
      }
    } catch {
      // keep default position
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(position));
    } catch {
      // ignore persistence failures
    }
  }, [position]);

  const panelStyle = useMemo(
    () => ({
      transform: `translate(${position.x}px, ${position.y}px)`
    }),
    [position.x, position.y]
  );

  const handlePointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (variant === 'docked') {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const initialX = position.x;
    const initialY = position.y;
    setDragging(true);

    const onMove = (moveEvent: PointerEvent) => {
      const nextX = clamp(initialX + moveEvent.clientX - startX, -220, 120);
      const nextY = clamp(initialY + moveEvent.clientY - startY, -80, 220);
      setPosition({ x: nextX, y: nextY });
    };

    const onUp = () => {
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    const trimmedDraft = draft.trim();
    const searchParams = new URLSearchParams({
      room: activeRoomId,
      return_to: '/workspace/pixel-lab'
    });
    if (trimmedDraft) {
      searchParams.set('prompt', trimmedDraft);
    }
    navigate(`/workspace/chat?${searchParams.toString()}`);
  };

  return (
    <aside
      className={`game-assistant game-assistant--${variant}${collapsed ? ' is-collapsed' : ''}${dragging ? ' is-dragging' : ''}`}
      style={variant === 'floating' ? panelStyle : undefined}
      aria-label="OpenClaw 工坊助手"
    >
      <div className="game-assistant__header" onPointerDown={handlePointerDown}>
        <div className="game-assistant__title">
          <span className="game-assistant__avatar" aria-hidden="true">
            <img src={openClawSprite} alt="" loading="lazy" decoding="async" />
          </span>
          <div>
            <strong>OpenClaw 工坊助手</strong>
            <small>当前房间：{activeRoom?.title ?? activeRoomId}</small>
          </div>
        </div>
        <button
          type="button"
          className="game-assistant__toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? '展开助手' : '收起助手'}
        >
          {collapsed ? '+' : '–'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="game-assistant__body">
          <div className="game-assistant__room-pill" aria-label="当前房间上下文">
            <span>当前</span>
            <strong>{activeRoom?.title ?? '训练之家'}</strong>
            <small>{activeRoom?.summary ?? '等待读取房间状态'}</small>
          </div>

          <div className="game-assistant__thread" aria-label="OpenClaw 对话">
            {messages.map((message) => (
              <div key={message.id} className={`game-assistant__message-row is-${message.sender}`}>
                {message.sender !== 'user' ? (
                  <span className="game-assistant__message-avatar" aria-hidden="true">
                    <img src={openClawSprite} alt="" loading="lazy" decoding="async" />
                  </span>
                ) : null}
                <div className="game-assistant__bubble">
                  <p>{message.text}</p>
                  {message.href && message.actionLabel ? (
                    <ButtonLink to={message.href} variant="ghost" size="sm">
                      {message.actionLabel}
                    </ButtonLink>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="game-assistant__quick-replies" aria-label="快捷回复">
            {suggestions.map((suggestion) => (
              <ButtonLink key={suggestion.id} to={suggestion.href} variant="secondary" size="sm">
                {suggestion.label}
              </ButtonLink>
            ))}
          </div>

          <form className="game-assistant__composer" aria-label="OpenClaw 输入框" onSubmit={handleSubmit}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="输入消息..."
              aria-label="输入消息"
            />
            <button type="submit" aria-label="发送到对话指挥室">
              ↗
            </button>
          </form>
        </div>
      )}
    </aside>
  );
}
