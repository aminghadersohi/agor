import { Avatar, Flex, Typography, theme } from 'antd';
import type { TeammateOption } from '../../utils/teammateLabels';
import { useTeammateProfileImageUrl } from '../ProfileImage/useTeammateProfileImageUrl';

// AntD has no regular-weight token; keeps the board regular inside a selected (bold) Select option.
const REGULAR_FONT_WEIGHT = 'normal';
// Room for a couple of characters plus the ellipsis, in multiples of the body font size.
const BOARD_MIN_WIDTH_CHARS = 3;

/** One line: photo (emoji fallback), name, then the board in regular secondary text; the board truncates first but keeps room for its ellipsis. */
export const TeammateOptionLabel: React.FC<{ option: TeammateOption }> = ({ option }) => {
  const { token } = theme.useToken();
  // Fork: a teammate's gallery photo replaces its emoji when it has one.
  const photoUrl = useTeammateProfileImageUrl(option.branch, 'small');
  return (
    <Flex gap={token.marginXS} align="center" style={{ minWidth: 0 }}>
      {photoUrl ? (
        <Avatar
          src={photoUrl}
          size={Math.round(token.fontSize * 1.5)}
          aria-hidden
          style={{ flex: 'none' }}
        />
      ) : (
        <span aria-hidden style={{ flex: 'none' }}>
          {option.emoji}
        </span>
      )}
      <Typography.Text
        ellipsis={{ tooltip: option.label }}
        style={{ flex: '0 1 auto', minWidth: 0 }}
      >
        {option.label}
      </Typography.Text>
      {option.context && (
        <Typography.Text
          type="secondary"
          ellipsis={{ tooltip: option.context }}
          style={{
            flex: '1 1 0%',
            minWidth: token.fontSize * BOARD_MIN_WIDTH_CHARS,
            fontWeight: REGULAR_FONT_WEIGHT,
          }}
        >
          {option.context}
        </Typography.Text>
      )}
    </Flex>
  );
};
