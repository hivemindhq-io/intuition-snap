/**
 * Shared presentational helpers for the transaction-insight surface.
 *
 * These wrap the MetaMask Snaps custom-UI primitives into the small set of
 * styled building blocks the insight cards reuse, so hierarchy (icon + heading
 * size) and address rendering stay consistent across the Safety, Familiarity,
 * Address, and Origin blocks instead of each component hand-rolling muted text.
 *
 * @module components/ui
 */

import {
  Box,
  Icon,
  Heading,
  Text,
  Address,
  Row,
  type IconName,
} from '@metamask/snaps-sdk/jsx';

import type { AddressClassification } from '../types';

const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/u;

/**
 * Whether a label is a bare hex address that the `Address` primitive can render
 * directly (with its Jazzicon + canonical truncation). ENS names and other
 * human labels fall back to plain text.
 *
 * @param label - A contact/subject label.
 * @returns True when the label is a 0x-prefixed 20-byte hex address.
 */
export function isHexAddress(label: string): label is `0x${string}` {
  return HEX_ADDRESS.test(label);
}

/**
 * A card sub-section heading. By default this is just a {@link Heading} — we
 * deliberately keep glyphs scarce so the panel doesn't turn into a wall of
 * icons. Pass an `icon` ONLY for the rare header that genuinely needs a
 * scannable signal of its own (e.g. the critical "Safety warning" banner); the
 * vast majority of section headers should be icon-less.
 *
 * Size defaults to `sm` (`headingSm`), which is the right weight for both
 * subject titles and sub-sections — `md`/`lg` are too large for this dense
 * surface and were the source of the oversized "Destination" / "dApp" titles.
 *
 * When an `icon` is supplied its color is `muted`/`default` only — the 6.10.0
 * `Icon` primitive does not expose a danger/error color, so tone is carried by
 * the surrounding `Row` variant, not the glyph.
 *
 * @param props - Heading props.
 * @param props.icon - Optional leading icon name; omit for plain headings.
 * @param props.children - The heading text.
 * @param props.size - Heading size; defaults to `sm`.
 * @returns A heading, optionally prefixed with an icon glyph.
 */
export const SectionHeading = ({
  icon,
  children,
  size = 'sm',
}: {
  icon?: `${IconName}`;
  children: string;
  size?: 'sm' | 'md' | 'lg';
}) => {
  if (!icon) {
    return <Heading size={size}>{children}</Heading>;
  }
  return (
    <Box direction="horizontal" alignment="start" center>
      <Icon name={icon} color="muted" size="md" />
      <Heading size={size}>{children}</Heading>
    </Box>
  );
};

/**
 * Renders an account label using the {@link Address} primitive (canonical
 * truncation + saved display name) when it is a bare hex address, or plain muted
 * text when it is an ENS name / other human label that `Address` cannot resolve.
 *
 * The Jazzicon avatar is OFF by default. Avatars are visually heavy and, in
 * lists of several contacts, become noise; worse, a generative maskicon can
 * coincidentally read like a green check and imply reassurance the data doesn't
 * support. Pass `avatar` only for a single, high-emphasis subject (never for
 * contact lists).
 *
 * @param props - Props.
 * @param props.label - The account label (hex address or ENS/name).
 * @param props.avatar - Show the Jazzicon avatar; defaults to false.
 * @returns An `Address` element for hex inputs, else a muted `Text`.
 */
export const AccountLabel = ({
  label,
  avatar = false,
}: {
  label: string;
  avatar?: boolean;
}) =>
  isHexAddress(label) ? (
    <Address address={label} displayName avatar={avatar} />
  ) : (
    <Text color="muted">{label}</Text>
  );

/**
 * Renders a single "Account type" row stating whether the destination is a
 * smart contract or a regular wallet (EOA), so the user can tell at a glance
 * what kind of thing they are interacting with.
 *
 * Definite verdicts read as "Smart contract" or "Wallet (EOA)". When we could
 * NOT verify, we never overclaim: a non-EVM chain hides the row entirely (a
 * contract/EOA verdict is meaningless there), and an EVM chain we couldn't
 * reach (RPC failed, or the chain isn't added to MetaMask) shows a neutral
 * "Couldn't verify on this network" instead of guessing.
 *
 * Note: a definite contract is often inferred from the transaction carrying
 * calldata (a contract call) rather than confirmed bytecode — but for the user
 * the meaningful fact is "this is a contract interaction", which calldata
 * reliably establishes.
 *
 * @param props - Props.
 * @param props.classification - The address classification result.
 * @returns A labeled row describing the account type, or null when hidden.
 */
export const AccountTypeBadge = ({
  classification,
}: {
  classification: AddressClassification;
}) => {
  if (classification.type === 'contract') {
    return (
      <Row label="Account type">
        <Text color="muted">Smart contract</Text>
      </Row>
    );
  }
  if (classification.type === 'eoa') {
    return (
      <Row label="Account type">
        <Text color="muted">Wallet (EOA)</Text>
      </Row>
    );
  }
  // Uncertain. On a non-EVM chain the contract/EOA distinction doesn't apply at
  // all, so hide the row rather than show a confusing label.
  if (classification.reason === 'non_evm') {
    return null;
  }
  // EVM chain we couldn't classify (RPC failed or chain not added to MetaMask).
  // Be honest about the gap instead of defaulting to "likely a contract".
  return (
    <Row label="Account type">
      <Text color="muted">Couldn't verify on this network</Text>
    </Row>
  );
};
