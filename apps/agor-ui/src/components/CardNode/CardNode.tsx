/**
 * CardNode - React Flow node component for rendering cards on the board canvas.
 *
 * Visual hierarchy:
 * - Colored left border from CardType (or the user's color override)
 * - Zone border color when pinned to a zone (matching BranchCard pattern);
 *   the user's own color still wins the left stripe, since it's the one
 *   channel that carries a meaning they chose
 * - CardType emoji + title (with optional URL link)
 * - Pin icon when in a zone (click to unpin)
 * - Description (markdown, collapsed after ~3 lines)
 * - Note (always shown in full, distinct background)
 */

import type { CardWithType } from '@agor-live/client';
import { DragOutlined, LinkOutlined, PushpinFilled } from '@ant-design/icons';
import { Button, Tooltip, Typography, theme } from 'antd';

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

import React, { useMemo } from 'react';
import { resolveEntityStripeColor } from '../../utils/boardEntityColors';
import {
  REACT_FLOW_DRAG_HANDLE_CLASS,
  REACT_FLOW_NO_DRAG_CLASS,
} from '../../utils/reactFlowDragClasses';
import { ensureColorVisible, isDarkTheme } from '../../utils/theme';
import { EntityColorPicker } from '../EntityColorPicker';
import { MarkdownPreview } from '../MarkdownRenderer';

const CARD_WIDTH = 380;

export interface CardNodeData {
  card: CardWithType;
  isPinned?: boolean;
  zoneName?: string;
  zoneColor?: string;
  onClick?: (cardId: string) => void;
  onUnpin?: (cardId: string) => void;
  /** Persist the user's chosen card color, or `null` to clear it. */
  onSetColor?: (cardId: string, color: string | null) => void | Promise<void>;
  /** Effective `board.edit` capability. Omitted only by isolated tests/fixtures. */
  canEdit?: boolean;
}

const CardNodeComponent = ({ data }: { data: CardNodeData }) => {
  const { token } = theme.useToken();
  const { card, isPinned, zoneName, zoneColor, onClick, onUnpin, onSetColor, canEdit } = data;

  const borderColor = card.effective_color || token.colorBorder;
  const emoji = card.effective_emoji;
  // The user's explicit choice, as distinct from a color inherited from the
  // card type. Only the override is editable here; the type default is a
  // Settings-level concern.
  const userColor = card.color_override;

  const stripeColor = resolveEntityStripeColor({
    userColor,
    zoneColor,
    isPinned,
    fallback: borderColor,
  });
  /** The three non-accent edges: zone membership, else the neutral card edge. */
  const edgeColor = isPinned && zoneColor ? zoneColor : token.colorBorderSecondary;

  // Match BranchCard pattern: ensure pin icon color is visible
  const isDarkMode = isDarkTheme(token);
  const visiblePinColor = useMemo(() => {
    if (!zoneColor) return undefined;
    return ensureColorVisible(zoneColor, isDarkMode, 50, 50);
  }, [zoneColor, isDarkMode]);

  return (
    <div
      onClick={() => onClick?.(card.card_id)}
      style={{
        width: CARD_WIDTH,
        background: token.colorBgContainer,
        // Per-edge longhands, not `border` + `borderLeft`. React applies only
        // the style keys that changed between renders, so a shorthand that
        // still covers the left edge leaves a stale stripe whenever the zone
        // color changes and the stripe doesn't — which is what happens when a
        // colored card is dragged into a zone.
        borderStyle: 'solid',
        borderTopColor: edgeColor,
        borderRightColor: edgeColor,
        borderBottomColor: edgeColor,
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftColor: stripeColor,
        borderLeftWidth: 4,
        borderRadius: token.borderRadiusLG,
        cursor: 'pointer',
        overflow: 'hidden',
        boxShadow: token.boxShadowTertiary,
        transition: 'box-shadow 0.2s, border-color 0.3s',
      }}
    >
      {/* Header: emoji + title + link + pin + drag */}
      <div
        className={REACT_FLOW_DRAG_HANDLE_CLASS}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          cursor: 'grab',
          borderBottom:
            card.description || card.note ? `1px solid ${token.colorBorderSecondary}` : 'none',
        }}
      >
        {emoji && <span style={{ fontSize: 16, flexShrink: 0 }}>{emoji}</span>}
        <Typography.Text
          strong
          style={{
            flex: 1,
            fontSize: 13,
            lineHeight: '1.3',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {card.title}
        </Typography.Text>
        {card.url && isSafeUrl(card.url) && (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={REACT_FLOW_NO_DRAG_CLASS}
            style={{ color: token.colorTextSecondary, flexShrink: 0 }}
          >
            <LinkOutlined style={{ fontSize: 12 }} />
          </a>
        )}
        {onSetColor && canEdit && (
          <EntityColorPicker
            value={userColor}
            onChange={(color) => onSetColor(card.card_id, color)}
            label="Card color"
          />
        )}
        {isPinned && (
          <Tooltip
            title={
              zoneName ? `Pinned to [${zoneName}] zone (click to unpin)` : 'Pinned (click to unpin)'
            }
          >
            <Button
              type="text"
              size="small"
              icon={<PushpinFilled style={{ color: visiblePinColor }} />}
              onClick={(e) => {
                e.stopPropagation();
                onUnpin?.(card.card_id);
              }}
              className={REACT_FLOW_NO_DRAG_CLASS}
              style={{ flexShrink: 0, width: 24, height: 24, padding: 0 }}
            />
          </Tooltip>
        )}
        <Button
          type="text"
          size="small"
          icon={<DragOutlined />}
          className={REACT_FLOW_DRAG_HANDLE_CLASS}
          style={{ cursor: 'grab', flexShrink: 0, width: 24, height: 24, padding: 0 }}
        />
      </div>

      {/* Description (collapsed) */}
      {card.description && (
        <div
          className={REACT_FLOW_NO_DRAG_CLASS}
          style={{
            padding: '8px 12px',
            borderBottom: card.note ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}
        >
          <MarkdownPreview key={card.card_id} content={card.description} />
        </div>
      )}

      {/* Note (always shown in full, distinct background) */}
      {card.note && (
        <div
          style={{
            padding: '8px 12px',
            background: token.colorFillQuaternary,
            borderTop: !card.description ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}
        >
          <Typography.Text
            style={{
              fontSize: 12,
              color: token.colorText,
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {card.note}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

const CardNode = React.memo(CardNodeComponent);

export default CardNode;
