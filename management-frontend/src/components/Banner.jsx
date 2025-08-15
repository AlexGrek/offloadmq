const Banner = ({ children, kind = "info" }) => (
  <div className={`banner ${kind}`}>{children}</div>
);

export default Banner;