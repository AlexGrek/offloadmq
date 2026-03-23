const Chip = ({ children, variant = "default" }) => (
  <span className={`chip chip-${variant}`}>{children}</span>
);

export default Chip;