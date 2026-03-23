import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, AlertTriangle, X } from 'lucide-react';

const ExpandableDeleteButton = ({ onDelete, itemName = "item", className = "", customActionText = "Delete", disabled = false }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const toggleExpand = (e) => {
        e.stopPropagation();
        if (!isDeleting) {
            setIsExpanded(!isExpanded);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        try {
            await onDelete();
            setIsExpanded(false);
        } catch (error) {
            console.error('Delete failed:', error);
        } finally {
            setIsDeleting(false);
        }
    };

    const handleCancel = () => {
        setIsExpanded(false);
    };

    return (
        <div className={`relative inline-block ${className}`}>
            <motion.div
                layout
                initial={false}
                animate={{
                    width: isExpanded ? 280 : 120,
                    height: isExpanded ? 180 : 40,
                    borderRadius: isExpanded ? 16 : 20
                }}
                transition={{
                    type: "spring",
                    stiffness: 150,
                    damping: 20,
                    mass: 0.8
                }}
                style={{
                    background: 'linear-gradient(145deg, #ffffff 0%, #fef2f2 100%)',
                    border: '1px solid rgba(239, 68, 68, 0.1)',
                    boxShadow: isExpanded
                        ? '0 6px 20px rgba(239, 68, 68, 0.08), 0 2px 8px rgba(239, 68, 68, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.9)'
                        : '0 3px 12px rgba(239, 68, 68, 0.06), 0 1px 4px rgba(239, 68, 68, 0.03), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
                    cursor: (isDeleting || disabled) ? 'not-allowed' : 'pointer',
                    position: 'relative',
                    overflow: 'hidden',
                    opacity: isDeleting || disabled ? 0.7 : 1
                }}
                onClick={toggleExpand}
            >
                {/* Header/Button Content */}
                <motion.div
                    layout
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: isExpanded ? '12px 16px 8px 16px' : '10px 16px',
                        gap: '8px',
                        justifyContent: isExpanded ? 'flex-start' : 'center'
                    }}
                >
                    <motion.div
                        layout
                        style={{
                            display: 'flex',
                            alignItems: 'center'
                        }}
                    >
                        <Trash2
                            size={isExpanded ? 16 : 18}
                            color="#ef4444"
                            style={{
                                filter: 'drop-shadow(0 1px 1px rgba(239, 68, 68, 0.2))'
                            }}
                        />
                    </motion.div>
                    <motion.span
                        layout
                        style={{
                            color: '#dc2626',
                            letterSpacing: '-0.01em',
                            textShadow: '0 1px 1px rgba(0, 0, 0, 0.03)',
                            fontSize: isExpanded ? '14px' : '15px',
                            fontWeight: isExpanded ? '600' : '500'
                        }}
                    >
                        {customActionText}
                    </motion.span>
                </motion.div>

                {/* Close Button */}
                <AnimatePresence>
                    {isExpanded && !isDeleting && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 0.3, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            whileHover={{ opacity: 0.8, scale: 1.1 }}
                            whileTap={{ scale: 0.95 }}
                            transition={{
                                type: "spring",
                                stiffness: 150,
                                damping: 20,
                                delay: 0.4
                            }}
                            style={{
                                position: 'absolute',
                                top: '12px',
                                right: '12px',
                                cursor: 'pointer',
                                padding: '4px',
                                borderRadius: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}
                            onClick={(e) => {
                                e.stopPropagation();
                                handleCancel();
                            }}
                        >
                            <X size={14} color="#6b7280" />
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Confirmation Dialog Content */}
                <AnimatePresence>
                    {isExpanded && (
                        <motion.div
                            initial={{ opacity: 0, y: -20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            transition={{
                                type: "spring",
                                stiffness: 150,
                                damping: 20,
                                delay: 0.2
                            }}
                            style={{
                                padding: '0 16px 16px 16px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '12px'
                            }}
                        >
                            {/* Warning Icon & Message */}
                            <motion.div
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{
                                    type: "spring",
                                    stiffness: 150,
                                    damping: 20,
                                    delay: 0.3
                                }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    padding: '8px 0'
                                }}
                            >
                                <AlertTriangle size={16} color="#f59e0b" />
                                <span style={{
                                    color: '#374151',
                                    fontSize: '13px',
                                    fontWeight: '500',
                                    lineHeight: '1.4'
                                }}>
                                    {customActionText} "{itemName}"?
                                </span>
                            </motion.div>

                            <motion.p
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{
                                    type: "spring",
                                    stiffness: 150,
                                    damping: 20,
                                    delay: 0.4
                                }}
                                style={{
                                    color: '#6b7280',
                                    fontSize: '12px',
                                    lineHeight: '1.4',
                                    margin: 0
                                }}
                            >
                                This action cannot be undone.
                            </motion.p>

                            {/* Action Buttons */}
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{
                                    type: "spring",
                                    stiffness: 150,
                                    damping: 20,
                                    delay: 0.5
                                }}
                                style={{
                                    display: 'flex',
                                    gap: '8px',
                                    marginTop: '4px'
                                }}
                            >
                                <motion.button
                                    whileHover={{ scale: 1.01 }}
                                    whileTap={{ scale: 0.99 }}
                                    disabled={isDeleting || disabled}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleCancel();
                                    }}
                                    style={{
                                        flex: 1,
                                        padding: '8px 12px',
                                        backgroundColor: 'white',
                                        color: '#6b7280',
                                        border: '1px solid rgba(107, 114, 128, 0.2)',
                                        borderRadius: '8px',
                                        fontSize: '12px',
                                        fontWeight: '500',
                                        cursor: isDeleting ? 'not-allowed' : 'pointer',
                                        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
                                        letterSpacing: '-0.01em',
                                        opacity: isDeleting ? 0.5 : 1
                                    }}
                                >
                                    Cancel
                                </motion.button>
                                <motion.button
                                    whileHover={{ scale: isDeleting ? 1 : 1.01 }}
                                    whileTap={{ scale: isDeleting ? 1 : 0.99 }}
                                    disabled={isDeleting}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleDelete();
                                    }}
                                    style={{
                                        flex: 1,
                                        padding: '8px 12px',
                                        backgroundColor: '#ef4444',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '8px',
                                        fontSize: '12px',
                                        fontWeight: '500',
                                        cursor: isDeleting ? 'not-allowed' : 'pointer',
                                        boxShadow: '0 2px 6px rgba(239, 68, 68, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                                        background: isDeleting
                                            ? '#9ca3af'
                                            : 'linear-gradient(145deg, #f87171, #ef4444)',
                                        letterSpacing: '-0.01em'
                                    }}
                                >
                                    {isDeleting ? 'Deleting...' : customActionText}
                                </motion.button>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Subtle Inner Shadow for Depth */}
                <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    borderRadius: 'inherit',
                    boxShadow: 'inset 0 1px 3px rgba(239, 68, 68, 0.03)',
                    pointerEvents: 'none'
                }} />
            </motion.div>
        </div>
    );
};

export default ExpandableDeleteButton;